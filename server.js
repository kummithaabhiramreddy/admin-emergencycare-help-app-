import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dbRepo from './db/index.js'; // Use Drizzle ORM database
import { sendRegistrationEmail, sendOTPEmail } from './emailService.js';

/* ── Password Security ── */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return password === storedHash; // Fallback for old plaintext passwords
  const [salt, key] = storedHash.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return key === hash;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
/* ── MIME types for static file serving ── */
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/* ── Parse JSON body ── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    // Increase limit for biometric images (10MB)
    const MAX_SIZE = 10 * 1024 * 1024; 
    
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_SIZE) {
        reject(new Error('Payload too large (Limit: 10MB)'));
      }
    });

    req.on('end', () => {
      if (!body) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        console.error('❌ JSON Parse Error:', err.message);
        console.error('Raw Body Start:', body.substring(0, 100));
        reject(new Error('Invalid JSON input: ' + err.message));
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

/* ── CORS headers ── */
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/* ── JSON response helper ── */
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

/* ════════════════════════════════════════════════════
   HTTP SERVER
   Integrated with PostgreSQL Database via Drizzle ORM
   ════════════════════════════════════════════════════ */
async function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const query = parsed.query;

  setCORS(res);
  console.log(`[HTTP] ${req.method} ${pathname}`);

  // Set No-Cache headers for all API requests to ensure fresh data from Neon
  if (pathname.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  /* ── Pre-flight ── */
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  /* ══════════════════════════════════════════════
     POST /api/auth/register — new user
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      console.error('❌ Request Body Error:', err.message);
      return sendJSON(res, 400, { error: 'Invalid request body.' });
    }
    console.log(`📥 Incoming user registration: email=${body.email}`);

    try {
      if (!body.email || !body.password || !body.name) {
        return sendJSON(res, 400, { error: 'Missing required fields.' });
      }

      // Check for existing user
      const existingUser = await dbRepo.getUserByEmail(body.email);
      if (existingUser) {
        return sendJSON(res, 409, { error: 'User with this email already exists.' });
      }

      // Hash the password securely before saving
      body.password = hashPassword(body.password);
      const result = await dbRepo.createUser(body);
      console.log(`✅  User created: ID ${result.id}`);
      return sendJSON(res, 201, { success: true, userId: result.id });
    } catch (err) {
      console.error('❌ User Registration Error:', err);
      return sendJSON(res, 500, { error: 'Failed to create user account.' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/auth/login — authenticate user
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      console.error('❌ Request Body Error:', err.message);
      return sendJSON(res, 400, { error: 'Invalid request body.' });
    }
    console.log(`🔐 Incoming login request: email=${body.email}`);

    try {
      if (!body.email || !body.password) {
        return sendJSON(res, 400, { error: 'Missing email or password.' });
      }

      const user = await dbRepo.getUserByEmail(body.email);

      if (!user) {
        return sendJSON(res, 401, { error: 'Invalid email or password.' });
      }

      // Secure password check using crypto scrypt
      if (!verifyPassword(body.password, user.password)) {
        return sendJSON(res, 401, { error: 'Invalid email or password.' });
      }

      console.log(`✅  User logged in: ${user.name}`);
      return sendJSON(res, 200, {
        success: true,
        user: { id: user.id, name: user.name, email: user.email }
      });
    } catch (err) {
      console.error('❌ Login Error:', err);
      return sendJSON(res, 500, { error: 'Authentication failed.' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/auth/google — Google Sign-In
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/auth/google') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJSON(res, 400, { error: 'Invalid request body.' });
    }
    const { name, email, googleId } = body;

    if (!email || !name) {
      return sendJSON(res, 400, { error: 'Missing name or email from Google' });
    }

    try {
      let user = await dbRepo.getUserByEmail(email);

      if (!user) {
        // Create new user for Google sign-in
        // Use a secure random string for password since they'll use Google
        const randomPass = crypto.randomBytes(32).toString('hex');
        const hashedPassword = hashPassword(randomPass);
        
        const result = await dbRepo.createUser({
          name,
          email,
          phone: '(Google)',
          password: hashedPassword
        });
        
        user = { id: result.id, name, email };
        console.log(`✅ New Google user created: ${email}`);
      } else {
        console.log(`✅ Existing Google user logged in: ${email}`);
      }

      return sendJSON(res, 200, {
        success: true,
        user: { id: user.id, name: user.name, email: user.email }
      });
    } catch (err) {
      console.error('❌ Google Auth API Error:', err);
      return sendJSON(res, 500, { error: 'Google authentication failed.' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/auth-flow/dispatch-otp — send reset code
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/auth-flow/dispatch-otp') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      console.error('❌ Request Body Error:', err.message);
      return sendJSON(res, 400, { error: 'Invalid request body.' });
    }
    const email = (body.email || '').toLowerCase().trim();

    if (!email) return sendJSON(res, 400, { error: 'Email required' });

    try {
      const user = await dbRepo.getUserByEmail(email);
      if (!user) return sendJSON(res, 404, { error: 'No account found with this email' });

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 mins

      await dbRepo.saveOTP(email, otp, expiresAt);
      const { simulated } = await sendOTPEmail(email, otp);

      return sendJSON(res, 200, { 
        success: true, 
        simulated, 
        otp: simulated ? otp : undefined,
        message: simulated ? 'OTP generated (Simulated)' : 'OTP sent to email' 
      });
    } catch (err) {
      console.error('❌ OTP Dispatch Error:', err);
      return sendJSON(res, 500, { error: 'Failed to send reset code' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/auth-flow/confirm-otp — verify reset code
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/auth-flow/confirm-otp') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      console.error('❌ Request Body Error:', err.message);
      return sendJSON(res, 400, { error: 'Invalid request body.' });
    }
    const email = (body.email || '').toLowerCase().trim();
    const otp = body.otp;

    if (!email || !otp) return sendJSON(res, 400, { error: 'Email and OTP required' });

    try {
      const record = await dbRepo.getOTP(email);
      if (!record || record.code !== otp) {
        return sendJSON(res, 400, { success: false, message: 'Invalid or expired code' });
      }

      if (Date.now() > Number(record.expiresAt)) {
        await dbRepo.deleteOTP(email);
        return sendJSON(res, 400, { success: false, message: 'Code has expired' });
      }

      return sendJSON(res, 200, { success: true, message: 'Code verified' });
    } catch (err) {
      console.error('❌ OTP Confirm Error:', err);
      return sendJSON(res, 500, { error: 'Verification failed' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/auth/reset-password — update password
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      console.error('❌ Request Body Error:', err.message);
      return sendJSON(res, 400, { error: 'Invalid request body.' });
    }
    const email = (body.email || '').toLowerCase().trim();
    const otp = body.otp;
    const newPassword = body.newPassword;

    if (!email || !otp || !newPassword) return sendJSON(res, 400, { error: 'Missing fields' });

    try {
      const record = await dbRepo.getOTP(email);
      if (!record || record.code !== otp || Date.now() > Number(record.expiresAt)) {
        return sendJSON(res, 400, { error: 'Invalid or expired session' });
      }

      const hashedPassword = hashPassword(newPassword);
      await dbRepo.updateUserPassword(email, hashedPassword);
      await dbRepo.deleteOTP(email);

      return sendJSON(res, 200, { success: true, message: 'Password updated successfully' });
    } catch (err) {
      console.error('❌ Password Reset Error:', err);
      return sendJSON(res, 500, { error: 'Failed to reset password' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/donors  — save a new registration
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && (pathname === '/api/donors' || pathname === '/api/register')) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      console.error('❌ Request Body Error:', err.message);
      return sendJSON(res, 400, { error: 'Invalid request body.' });
    }
    console.log(`📥 Incoming registration: type=${body.type}, donorId=${body.donorId || 'new'}`);

    const emailKey = String(body.email || '').toLowerCase().trim();
    const phoneKey = String(body.phone || '').replace(/\D/g, '');
    const phoneLast10 = phoneKey.slice(-10);

    /* Duplicate check and update logic */
    try {
      const existingDonors = await dbRepo.getAllDonors();
      const dup = existingDonors.find(d => {
        const dbPhone = (d.phone || '').replace(/\D/g, '');
        const dbPhoneLast10 = dbPhone.slice(-10);
        const phoneMatch = phoneLast10.length === 10 && dbPhoneLast10.length === 10 && phoneLast10 === dbPhoneLast10;
        const emailMatch = emailKey && d.email && d.email.toLowerCase().trim() === emailKey;
        return emailMatch || phoneMatch;
      });

      if (dup) {
        console.log(`♻️ Existing donor found (${dup.donorId}). Updating stats instead of creating new row.`);

        // Check cooldown for Blood donors
        if ((body.type === 'Blood' || body.type === 'Both') && (dup.type === 'Blood' || dup.type === 'Both')) {
          const daysPassed = (Date.now() - dup.timestamp) / 86400000;
          if (daysPassed < 90) {
            const daysLeft = Math.ceil(90 - daysPassed);
            console.warn(`⏳ Donor ${dup.donorId} is within 90-day cooldown. (${daysLeft} days left)`);
            // We can still allow updating, but maybe warn the user on frontend.
            // For now, let's allow it but just log the registration as a new "donation" event.
          }
        }

        const currentDonation = body.type === 'Blood' ? `Blood (${body.bloodgroup || 'N/A'})` : (body.type === 'Both' ? `Blood (${body.bloodgroup || 'N/A'}) & Organ (${Array.isArray(body.organs) ? body.organs.join('/') : ''})` : `Organ (${Array.isArray(body.organs) ? body.organs.join('/') : ''})`);

        const newCount = (dup.donated_count || 0) + 1;
        const newDetail = dup.donated_detail ? `${dup.donated_detail}, ${currentDonation}` : currentDonation;

        await dbRepo.updateDonor(dup.donorId, {
          name: body.name || dup.name,
          city: body.city || dup.city,
          donated_count: newCount,
          donated_detail: newDetail,
          timestamp: Date.now(), // Update last registration time
          registeredOn: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
        });

        // Send email for update too
        sendRegistrationEmail({ ...dup, ...body, donated_count: newCount }).catch(e => console.error('Email update trigger failed:', e));

        return sendJSON(res, 201, { success: true, donorId: dup.donorId, updated: true, donated_count: newCount });
      }
    } catch (err) { console.error('DB Update/Check Error:', err); }

    /* Build NEW record */
    var rawBg = body.bloodgroup || 'N/A';
    // ensure blood group string fits varchar(10) column
    var bloodgroup = rawBg.length > 10 ? rawBg.slice(0, 10) : rawBg;

    var initDetail = body.type === 'Blood' ? `Blood (${bloodgroup})` : (body.type === 'Both' ? `Blood (${bloodgroup}) & Organ (${Array.isArray(body.organs) ? body.organs.join('/') : ''})` : `Organ (${Array.isArray(body.organs) ? body.organs.join('/') : ''})`);

    var record = {
      donorId: body.donorId || `BHM-${Date.now().toString(36).toUpperCase().slice(-6)}`,
      name: body.name || '',
      dob: body.dob || '',
      bloodgroup: bloodgroup,
      type: body.type || '',
      organs: Array.isArray(body.organs) ? body.organs : [],
      city: body.city || '',
      phone: phoneKey,
      email: emailKey,
      biometric: body.biometric || null,
      registeredOn: body.registeredOn || new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
      timestamp: Number(body.timestamp) || Date.now(),
      donated_count: 1, // Automatically starts at 1
      donated_detail: initDetail,
      received_count: 0,
      received_detail: 'None yet',
    };
    console.log('DEBUG record before save:', record);

    try {
      const result = await dbRepo.saveDonor(record);
      
      // Fire-and-forget email sending (don't block the response)
      if (record.email) {
        sendRegistrationEmail(record).catch(e => console.error('Email trigger failed:', e));
      }

      return sendJSON(res, 201, { success: true, donorId: record.donorId, dbId: result.id });
    } catch (err) {
      console.error('❌ POST /api/donors Error:', err);
      return sendJSON(res, 500, { error: 'Failed to save donor to database.' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/donors/donate — log a successful donation
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/donors/donate') {
    const body = await readBody(req);
    console.log(`💉 Log donation event: donorId=${body.donorId}`);

    try {
      if (!body.donorId) {
        return sendJSON(res, 400, { error: 'Missing donorId.' });
      }

      const success = await dbRepo.logDonationEvent({
        donorId: body.donorId,
        type: body.type || 'Blood',
        bloodGroup: body.bloodGroup,
        organType: body.organType
      });

      if (!success) {
        return sendJSON(res, 404, { error: 'Donor not found.' });
      }

      return sendJSON(res, 200, { success: true });
    } catch (err) {
      console.error('❌ Donation Log Error:', err);
      return sendJSON(res, 500, { error: 'Failed to log donation.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/donors  — list all donors
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/donors') {
    try {
      const donors = await dbRepo.getAllDonors();
      return sendJSON(res, 200, { total: donors.length, donors });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to retrieve donors.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/donors/debug  — raw donor records for debugging
     Shows exact type, bloodgroup, organs values as stored in DB
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/donors/debug') {
    try {
      const donors = await dbRepo.getAllDonors();
      const summary = donors.map(d => ({
        donorId: d.donorId,
        name: d.name,
        type: d.type,
        bloodgroup: d.bloodgroup,
        organs: d.organs,
        city: d.city,
        registeredOn: d.registeredOn
      }));
      return sendJSON(res, 200, { total: summary.length, donors: summary });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to retrieve donors.' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/donors/request — log an emergency request
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/donors/request') {
    const body = await readBody(req);
    console.log(`📡 Log emergency request: donorId=${body.donorId}, requester=${body.requesterName}`);

    try {
      if (!body.donorId || !body.requesterName) {
        return sendJSON(res, 400, { error: 'Missing donorId or requesterName.' });
      }

      await dbRepo.logEmergencyRequest({
        donorId: body.donorId,
        requesterName: body.requesterName,
        requestType: body.requestType || 'Blood',
        bloodGroup: body.bloodGroup || null,
        organType: body.organType || null,
        details: body.details || ''
      });

      return sendJSON(res, 200, { success: true });
    } catch (err) {
      console.error('❌ Request Log Error:', err);
      return sendJSON(res, 500, { error: 'Failed to log emergency request.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/requests — list all emergency requests
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/requests') {
    try {
      const requests = await dbRepo.getAllRequests();
      return sendJSON(res, 200, { total: requests.length, requests });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to retrieve requests.' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/requests/update — update an emergency request
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/requests/update') {
    const body = await readBody(req);
    try {
      if (!body.id) {
        return sendJSON(res, 400, { error: 'Missing request id.' });
      }
      
      const requests = await dbRepo.getAllRequests();
      const reqRecord = requests.find(r => r.id === body.id);
      if (!reqRecord) {
        return sendJSON(res, 404, { error: 'Request not found.' });
      }

      let detailsObj = {};
      try { detailsObj = JSON.parse(reqRecord.details || '{}'); } catch(e){}
      
      detailsObj = { ...detailsObj, ...body.details };

      await dbRepo.updateEmergencyRequest(body.id, {
        details: JSON.stringify(detailsObj)
      });

      return sendJSON(res, 200, { success: true });
    } catch (err) {
      console.error('❌ Request Update Error:', err);
      return sendJSON(res, 500, { error: 'Failed to update emergency request.' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/donors/donate — log a donation event
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/donors/donate') {
    const body = await readBody(req);
    console.log(`💉 Log donation event: donorId=${body.donorId}, type=${body.type}`);

    try {
      if (!body.donorId || !body.type) {
        return sendJSON(res, 400, { error: 'Missing donorId or type.' });
      }

      await dbRepo.logDonationEvent({
        donorId: body.donorId,
        type: body.type, // 'Blood' or 'Organ'
        bloodGroup: body.bloodGroup || null,
        organType: body.organType || null
      });

      return sendJSON(res, 200, { success: true });
    } catch (err) {
      console.error('❌ Donation log error:', err);
      return sendJSON(res, 500, { error: 'Failed to log donation.' });
    }
  }

  /* ══════════════════════════════════════════════
     POST /api/donors/delete — delete a donor
  ══════════════════════════════════════════════ */
  if (req.method === 'POST' && pathname === '/api/donors/delete') {
    const body = await readBody(req);
    console.log(`🗑️ Deleting donor: donorId=${body.donorId}`);

    try {
      if (!body.donorId) {
        return sendJSON(res, 400, { error: 'Missing donorId.' });
      }

      await dbRepo.deleteDonor(body.donorId);
      return sendJSON(res, 200, { success: true });
    } catch (err) {
      console.error('❌ Delete donor error:', err);
      return sendJSON(res, 500, { error: 'Failed to delete donor.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/search/blood — search blood donors
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/search/blood') {
    console.log(`🔍 Blood Search Request: name="${query.name || ''}", city="${query.city || ''}", groups="${query.bloodGroups || ''}"`);
    try {
      const results = await dbRepo.searchBloodDonors(query);
      return sendJSON(res, 200, { donors: results });
    } catch (err) {
      console.error('Blood search error:', err);
      return sendJSON(res, 500, { error: 'Blood search failed.' });
    }
  }


  /* ══════════════════════════════════════════════
     GET /api/search/organs  — search organ donors
     ?organs=Heart,Kidneys&name=&phone=&city=
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/search/organs') {
    console.log(`🔍 Organ Search Request: name="${query.name || ''}", city="${query.city || ''}", organs="${query.organs || ''}"`);
    try {
      const results = await dbRepo.searchOrganDonors(query);
      return sendJSON(res, 200, { donors: results });
    } catch (err) {
      console.error('Organ search error:', err);
      return sendJSON(res, 500, { error: 'Organ search failed.' });
    }
  }


  /* ══════════════════════════════════════════════
     GET /api/health  — health check
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/health') {
    try {
      console.log('📡 Database Health Check: Testing connection...');
      const allDonors = await dbRepo.getAllDonors(); 
      return sendJSON(res, 200, { 
        status: 'ok', 
        database: 'connected',
        count: allDonors.length,
        env: process.env.DATABASE_URL ? 'production' : 'development'
      });
    } catch (err) {
      console.error('❌ Database Health check failed:', err.message);
      return sendJSON(res, 500, { 
        status: 'error', 
        message: err.message,
        hint: 'Check database connectivity and credentials.'
      });
    }
  }


  /* ══════════════════════════════════════════════
     GET /api/analytics  — interactive analytics dashboard
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/analytics') {
    try {
      const stats = await dbRepo.getStats();
      const byType = await dbRepo.countByType();
      const byBloodGroup = await dbRepo.countByBloodGroup();
      const recent = await dbRepo.getRecentDonors(5);

      return sendJSON(res, 200, {
        dashboard: {
          total_donors: stats.total_donors,
          database: stats.database,
        },
        breakdown: {
          by_type: byType,
          by_blood_group: byBloodGroup,
        },
        recent_registrations: recent,
      });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to fetch analytics.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/stats  — database statistics
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/stats') {
    try {
      const stats = await dbRepo.getStats();
      const byType = await dbRepo.countByType();
      const byBloodGroup = await dbRepo.countByBloodGroup();

      return sendJSON(res, 200, {
        ...stats,
        by_type: byType,
        by_blood_group: byBloodGroup,
      });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to fetch statistics.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/dashboard/blood-groups  — blood group availability
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/dashboard/blood-groups') {
    try {
      const result = await dbRepo.getBloodGroupAvailability();
      return sendJSON(res, 200, { blood_group_availability: result });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to fetch blood group data.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/dashboard/donation-types  — donation type breakdown
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/dashboard/donation-types') {
    try {
      const result = await dbRepo.getDonationTypeBreakdown();
      return sendJSON(res, 200, { donation_type_breakdown: result });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to fetch donation type data.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/dashboard/cities  — city-wise distribution
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/dashboard/cities') {
    try {
      const result = await dbRepo.getCityWiseDistribution();
      return sendJSON(res, 200, { city_wise_distribution: result });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to fetch city data.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/donors/by-blood-group — donors by blood group
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/donors/by-blood-group') {
    try {
      const bloodGroup = query.group;
      if (!bloodGroup) {
        return sendJSON(res, 400, { error: 'Blood group parameter required' });
      }
      const result = await dbRepo.getDonorsByBloodGroup(bloodGroup);
      return sendJSON(res, 200, { blood_group: bloodGroup, total: result.length, donors: result });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to fetch donors by blood group.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/donors/by-city — donors by city
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname === '/api/donors/by-city') {
    try {
      const city = query.city;
      if (!city) {
        return sendJSON(res, 400, { error: 'City parameter required' });
      }
      const result = await dbRepo.getDonorsByCity(city);
      return sendJSON(res, 200, { city: city, total: result.length, donors: result });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to fetch donors by city.' });
    }
  }

  /* ══════════════════════════════════════════════
     GET /api/donors/recent — recent registrations
  ══════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════
     GET /api/donor/:userId — fetch single donor record
  ══════════════════════════════════════════════ */
  if (req.method === 'GET' && pathname.startsWith('/api/donor/')) {
    try {
      const userId = pathname.replace('/api/donor/', '');
      if (!userId) {
        return sendJSON(res, 400, { error: 'User ID required.' });
      }

      const allDonors = await dbRepo.getAllDonors();
      const donor = allDonors.find(d => d.donorId === userId || String(d.id) === userId);

      if (!donor) {
        return sendJSON(res, 404, { error: 'Donor not found.' });
      }

      // Parse JSON fields if they exist
      const donorData = {
        ...donor,
        donated_detail: donor.donated_detail ? (typeof donor.donated_detail === 'string' ? JSON.parse(donor.donated_detail) : donor.donated_detail) : [],
        received_detail: donor.received_detail ? (typeof donor.received_detail === 'string' ? JSON.parse(donor.received_detail) : donor.received_detail) : [],
        organs: donor.organs ? (typeof donor.organs === 'string' ? donor.organs.split(',').map(o => o.trim()) : donor.organs) : []
      };

      return sendJSON(res, 200, { donor: donorData });
    } catch (err) {
      console.error('❌ Fetch donor error:', err);
      return sendJSON(res, 500, { error: 'Failed to fetch donor record.' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/donors/recent') {
    try {
      const limit = Math.min(parseInt(query.limit, 10) || 10, 100);
      const result = await dbRepo.getRecentDonors(limit);
      return sendJSON(res, 200, { total: result.length, donors: result });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to fetch recent donors.' });
    }
  }

  /* ══════════════════════════════════════════════
     Static file serving (serves your HTML pages)
  ══════════════════════════════════════════════ */
  let filePath = path.join(__dirname, pathname === '/' ? '/index.html' : pathname);
  const ext = path.extname(filePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const mime = MIME[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    return fs.createReadStream(filePath).pipe(res);
  }

  if (pathname.startsWith('/api/')) {
    return sendJSON(res, 404, { error: `Endpoint not found: ${req.method} ${pathname}` });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found: ' + pathname);
}

// Only start listening locally (not on Vercel)
if (!process.env.VERCEL) {
  const server = http.createServer(handler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server live at http://localhost:${PORT}`);
  });
}

// Export handler for Vercel Serverless
export default handler;
