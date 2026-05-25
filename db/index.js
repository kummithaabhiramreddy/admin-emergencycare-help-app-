/**
 * Drizzle ORM Database Module
 * Interactive data management with type safety and advanced querying
 */

import { db } from './client.js';
import { donors, users, emergencyRequests, otps, emergencyCare } from './schema.js';
import { eq, or, ilike, gt, and, sql, desc, count, inArray } from 'drizzle-orm';

export default {
  /**
   * Save a new donor to the database
   */
  saveDonor: async (donor) => {
    try {
      const result = await db.insert(donors).values({
        donorId: donor.donorId,
        name: donor.name,
        dob: donor.dob,
        bloodgroup: donor.bloodgroup,
        type: donor.type,
        organs: JSON.stringify(donor.organs || []),
        city: donor.city,
        phone: donor.phone,
        email: donor.email,
        biometric: donor.biometric,
        registeredOn: donor.registeredOn,
        timestamp: donor.timestamp,
        donated_count: donor.donated_count || 1,
        donated_detail: donor.donated_detail || '',
        received_count: donor.received_count || 0,
        received_detail: donor.received_detail || '',
      }).returning({ id: donors.id });

      return { id: result[0]?.id };
    } catch (err) {
      console.error('❌ Database save error:', err);
      throw err;
    }
  },

  /**
   * Log a successful donation event and update donor stats
   */
  logDonationEvent: async (data) => {
    try {
      const donor = await db.select().from(donors).where(eq(donors.donorId, data.donorId)).limit(1);
      if (donor[0]) {
        let currentDetail = donor[0].donated_detail || '';
        const newItem = data.type === 'Blood'
          ? `Blood (${data.bloodGroup || 'N/A'})`
          : `Organ (${data.organType || 'N/A'})`;

        const updatedDetail = currentDetail ? `${currentDetail}, ${newItem}` : newItem;

        await db.update(donors)
          .set({
            donated_count: sql`${donors.donated_count} + 1`,
            donated_detail: updatedDetail
          })
          .where(eq(donors.donorId, data.donorId));
        return true;
      }
      return false;
    } catch (err) {
      console.error('❌ Log donation event error:', err);
      throw err;
    }
  },

  /**
   * Log an emergency request for a donor and update their stats
   */
  logEmergencyRequest: async (data) => {
    try {
      // 1. Insert detailed request log into the primary requests table
      const timestamp = Date.now();
      await db.insert(emergencyRequests).values({
        donorId: data.donorId,
        requesterName: data.requesterName,
        requestType: data.requestType, // 'Blood' or 'Organ'
        bloodGroup: data.bloodGroup || null,
        organType: data.organType || null,
        details: data.details || '',
        timestamp,
      });

      // 2. Also store a copy in emergency_care for compatibility with Neon expectations
      await db.insert(emergencyCare).values({
        donorId: data.donorId,
        requesterName: data.requesterName,
        requestType: data.requestType,
        bloodGroup: data.bloodGroup || null,
        organType: data.organType || null,
        details: data.details || '',
        timestamp,
      });

      // 3. Fetch current donor status to update detail strings
      const donor = await db.select().from(donors).where(eq(donors.donorId, data.donorId)).limit(1);
      if (donor[0]) {
        let currentDetail = donor[0].received_detail || '';
        const newItem = data.requestType === 'Blood'
          ? `Blood (${data.bloodGroup})`
          : `Organ (${data.organType})`;

        const updatedDetail = currentDetail && currentDetail !== 'None yet' ? `${currentDetail}, ${newItem}` : newItem;
        const newCount = (Number(donor[0].received_count) || 0) + 1;

        // 3. Increment received count and update detail string
        await db.update(donors)
          .set({
            received_count: newCount,
            received_detail: updatedDetail
          })
          .where(eq(donors.donorId, data.donorId));
      }

      return true;
    } catch (err) {
      console.error('❌ Log emergency request error:', err);
      throw err;
    }
  },

  /**
   * Get all donors with parsed organs data
   */
  getAllDonors: async () => {
    try {
      const result = await db.select().from(donors).orderBy(desc(donors.timestamp));

      return result.map((row) => ({
        ...row,
        organs: (() => {
          try {
            return JSON.parse(row.organs || '[]');
          } catch (e) {
            return [];
          }
        })(),
      }));
    } catch (err) {
      console.error('❌ Database query error:', err);
      throw err;
    }
  },

  /**
   * Get all emergency requests from the database
   * Supports both the current emergency_requests table and compatible fallback tables.
   */
  getAllRequests: async () => {
    try {
      const requests = await db.select().from(emergencyRequests).orderBy(desc(emergencyRequests.timestamp));
      if (requests.length) {
        return requests;
      }

      // Fallback to emergency_care if emergency_requests is empty
      const fallbackCare = await db.select().from(emergencyCare).orderBy(desc(emergencyCare.timestamp));
      if (fallbackCare.length) {
        return fallbackCare;
      }

      return requests;
    } catch (err) {
      console.warn('⚠️ emergency_requests query failed, trying fallback tables:', err.message);

      try {
        const fallbackCare = await db.select().from(emergencyCare).orderBy(desc(emergencyCare.timestamp));
        if (fallbackCare.length) {
          return fallbackCare;
        }
      } catch (fallbackErr) {
        console.warn('⚠️ emergency_care fallback query failed:', fallbackErr.message);
      }

      try {
        const rawFallback = await db.execute(sql`SELECT * FROM emergency_request ORDER BY timestamp DESC`);
        if (Array.isArray(rawFallback) && rawFallback.length) {
          return rawFallback;
        }
      } catch (rawErr) {
        console.warn('⚠️ emergency_request raw query failed:', rawErr.message);
      }

      try {
        const rawFallbackAlt = await db.execute(sql`SELECT * FROM emergency_requests ORDER BY timestamp DESC`);
        if (Array.isArray(rawFallbackAlt) && rawFallbackAlt.length) {
          return rawFallbackAlt;
        }
      } catch (rawErrAlt) {
        console.warn('⚠️ emergency_requests raw query failed:', rawErrAlt.message);
      }

      console.error('❌ Get all requests error:', err);
      throw err;
    }
  },

  /**
   * Search donors by multiple criteria with Drizzle
   */
  searchDonors: async (query) => {
    try {
      const conditions = [];

      if (query.name) {
        conditions.push(ilike(donors.name, `%${query.name}%`));
      }

      if (query.phone) {
        conditions.push(ilike(donors.phone, `%${query.phone}%`));
      }

      if (query.bloodGroup) {
        conditions.push(eq(donors.bloodgroup, query.bloodGroup));
      }

      if (query.type) {
        conditions.push(ilike(donors.type, `%${query.type}%`));
      }

      if (query.city) {
        conditions.push(ilike(donors.city, `%${query.city}%`));
      }

      let selectQuery = db.select().from(donors);

      if (conditions.length > 0) {
        selectQuery = selectQuery.where(or(...conditions));
      }

      const result = await selectQuery.orderBy(desc(donors.timestamp));

      return result.map((row) => ({
        ...row,
        organs: (() => {
          try {
            return JSON.parse(row.organs || '[]');
          } catch (e) {
            return [];
          }
        })(),
      }));
    } catch (err) {
      console.error('❌ Search error:', err);
      throw err;
    }
  },

  /**
   * Specialized Blood Donor Search using Drizzle
   * Only returns results if a city is provided.
   */
  searchBloodDonors: async (query) => {
    try {
      const { city, bloodGroups } = query;
      console.log(`[DB] Blood Search: city="${city || ''}", groups="${bloodGroups || ''}"`);

      if (!city) {
        console.log('[DB] Blood search skipped: No city provided.');
        return [];
      }

      // Match donors who are Blood or Both type (case-insensitive)
      const conditions = [
        or(
          eq(donors.type, 'Blood'),
          eq(donors.type, 'Both'),
          ilike(donors.type, 'blood'),
          ilike(donors.type, 'both')
        ),
        ilike(donors.city, `%${city.trim()}%`)
      ];

      if (bloodGroups) {
        const groups = bloodGroups.split(',').map(g => g.trim()).filter(g => g);
        if (groups.length > 0) {
          // Use OR of ILIKE for case-insensitive matching of blood groups
          const groupConditions = groups.map(g => ilike(donors.bloodgroup, g));
          conditions.push(or(...groupConditions));
        }
      }

      const result = await db
        .select()
        .from(donors)
        .where(and(...conditions))
        .orderBy(desc(donors.timestamp));

      console.log(`[DB] Blood Search found ${result.length} result(s).`);
      return result.map((row) => ({
        ...row,
        organs: (() => { try { return JSON.parse(row.organs || '[]'); } catch (e) { return []; } })()
      }));
    } catch (err) {
      console.error('❌ Blood search error:', err);
      throw err;
    }
  },

  /**
   * Specialized Organ Donor Search using Drizzle
   * Only returns results if BOTH city and organ type are provided.
   * Organs are stored as a JSON array string e.g. '["Heart","Kidneys"]'
   * We use ilike on the raw JSON string for each organ, which works because
   * JSON.stringify(['Heart']) => '["Heart"]' and ilike '%Heart%' matches it.
   */
  searchOrganDonors: async (query) => {
    try {
      const { city, organs } = query;
      console.log(`[DB] Organ Search: city="${city || ''}", organs="${organs || ''}"`);

      if (!city || !organs) {
        console.log('[DB] Organ search skipped: Missing city or organ selection.');
        return [];
      }

      const requestedOrgans = organs.split(',').map(o => o.trim()).filter(o => o);
      if (requestedOrgans.length === 0) {
        return [];
      }

      // Each organ chip value must appear somewhere in the JSON string
      // e.g. organs column = '["Heart","Kidneys"]', searching for 'Heart' => ilike '%Heart%'
      const organConditions = requestedOrgans.map(o => ilike(donors.organs, `%${o}%`));

      const whereClause = and(
        // Match Organ-only or Both type donors (exact match, case variations)
        or(
          eq(donors.type, 'Organ'),
          eq(donors.type, 'Both'),
          ilike(donors.type, 'organ'),
          ilike(donors.type, 'both')
        ),
        ilike(donors.city, `%${city.trim()}%`),
        // At least one of the requested organs must be found in the stored JSON
        or(...organConditions)
      );

      const result = await db
        .select()
        .from(donors)
        .where(whereClause)
        .orderBy(desc(donors.timestamp));

      console.log(`[DB] Organ Search found ${result.length} result(s).`);

      // Post-filter: parse organs JSON and do a real array check to be accurate
      const filtered = result.filter((row) => {
        try {
          const donorOrgans = JSON.parse(row.organs || '[]').map(o => o.toLowerCase());
          return requestedOrgans.some(req => donorOrgans.some(o => o.includes(req.toLowerCase()) || req.toLowerCase().includes(o)));
        } catch (e) {
          return false;
        }
      });

      return filtered.map((row) => ({
        ...row,
        organs: (() => { try { return JSON.parse(row.organs || '[]'); } catch (e) { return []; } })()
      }));
    } catch (err) {
      console.error('❌ Organ search error:', err);
      throw err;
    }
  },

  /**
   * Check for duplicate donor registrations within cooldown period
   */
  checkDuplicate: async (email, phone, type, cooldown) => {
    try {
      const minTimestamp = Date.now() - cooldown;

      const result = await db
        .select()
        .from(donors)
        .where(
          and(
            or(eq(donors.email, email), eq(donors.phone, phone)),
            eq(donors.type, type),
            gt(donors.timestamp, minTimestamp)
          )
        )
        .limit(1);

      return result[0] || null;
    } catch (err) {
      console.error('❌ Duplicate check error:', err);
      throw err;
    }
  },

  /**
   * Get database statistics
   */
  getStats: async () => {
    try {
      const donorResult = await db.select({ count: count() }).from(donors);
      const userResult = await db.select({ count: count() }).from(users);

      return {
        total_donors: Number(donorResult[0]?.count ?? 0),
        total_users: Number(userResult[0]?.count ?? 0),
        database: 'PostgreSQL + Drizzle ORM',
      };
    } catch (err) {
      console.error('❌ Stats error:', err);
      throw err;
    }
  },

  /**
   * Get donors by blood group
   */
  getDonorsByBloodGroup: async (bloodGroup) => {
    try {
      const result = await db
        .select()
        .from(donors)
        .where(eq(donors.bloodgroup, bloodGroup))
        .orderBy(desc(donors.timestamp));

      return result.map((row) => ({
        ...row,
        organs: (() => {
          try {
            return JSON.parse(row.organs || '[]');
          } catch (e) {
            return [];
          }
        })(),
      }));
    } catch (err) {
      console.error('❌ Blood group query error:', err);
      throw err;
    }
  },

  /**
   * Get organ donors
   */
  getOrganDonors: async (organ) => {
    try {
      // Filter by type (Organ or Both) first to reduce data fetched
      const result = await db
        .select()
        .from(donors)
        .where(
          or(
            eq(donors.type, 'Organ'),
            eq(donors.type, 'Both'),
            ilike(donors.type, 'organ'),
            ilike(donors.type, 'both')
          )
        );

      return result
        .filter((donor) => {
          try {
            const organs = JSON.parse(donor.organs || '[]').map(o => o.toLowerCase());
            return organs.some(o => o.includes(organ.toLowerCase()) || organ.toLowerCase().includes(o));
          } catch (e) {
            return false;
          }
        })
        .map((row) => ({
          ...row,
          organs: (() => {
            try {
              return JSON.parse(row.organs || '[]');
            } catch (e) {
              return [];
            }
          })(),
        }));
    } catch (err) {
      console.error('❌ Organ donor query error:', err);
      throw err;
    }
  },

  /**
   * Get donors by city
   */
  getDonorsByCity: async (city) => {
    try {
      const result = await db
        .select()
        .from(donors)
        .where(ilike(donors.city, `%${city}%`))
        .orderBy(desc(donors.timestamp));

      return result.map((row) => ({
        ...row,
        organs: (() => {
          try {
            return JSON.parse(row.organs || '[]');
          } catch (e) {
            return [];
          }
        })(),
      }));
    } catch (err) {
      console.error('❌ City query error:', err);
      throw err;
    }
  },

  /**
   * Get recent registrations — newest first
   */
  getRecentDonors: async (limit = 10) => {
    try {
      const result = await db
        .select()
        .from(donors)
        .orderBy(desc(donors.timestamp))
        .limit(limit);

      return result.map((row) => ({
        ...row,
        organs: (() => {
          try {
            return JSON.parse(row.organs || '[]');
          } catch (e) {
            return [];
          }
        })(),
      }));
    } catch (err) {
      console.error('❌ Recent donors query error:', err);
      throw err;
    }
  },

  /**
   * Count donors by donation type
   */
  countByType: async () => {
    try {
      const result = await db
        .select({ type: donors.type, count: count() })
        .from(donors)
        .groupBy(donors.type);

      return result;
    } catch (err) {
      console.error('❌ Count by type error:', err);
      throw err;
    }
  },

  /**
   * Count donors by blood group
   */
  countByBloodGroup: async () => {
    try {
      const result = await db
        .select({ bloodgroup: donors.bloodgroup, count: count() })
        .from(donors)
        .groupBy(donors.bloodgroup);

      return result;
    } catch (err) {
      console.error('❌ Count by blood group error:', err);
      throw err;
    }
  },

  /**
   * Get blood group availability — used by /api/dashboard/blood-groups
   */
  getBloodGroupAvailability: async () => {
    try {
      const result = await db
        .select({
          bloodgroup: donors.bloodgroup,
          total: count(),
        })
        .from(donors)
        .where(
          or(
            eq(donors.type, 'Blood'),
            eq(donors.type, 'Both'),
            ilike(donors.type, 'blood'),
            ilike(donors.type, 'both')
          )
        )
        .groupBy(donors.bloodgroup)
        .orderBy(desc(count()));

      return result.map((r) => ({
        blood_group: r.bloodgroup,
        donor_count: Number(r.total),
      }));
    } catch (err) {
      console.error('❌ Blood group availability error:', err);
      throw err;
    }
  },

  /**
   * Get donation type breakdown — used by /api/dashboard/donation-types
   */
  getDonationTypeBreakdown: async () => {
    try {
      const result = await db
        .select({
          type: donors.type,
          total: count(),
        })
        .from(donors)
        .groupBy(donors.type)
        .orderBy(desc(count()));

      return result.map((r) => ({
        donation_type: r.type,
        donor_count: Number(r.total),
      }));
    } catch (err) {
      console.error('❌ Donation type breakdown error:', err);
      throw err;
    }
  },

  /**
   * Get city-wise distribution — used by /api/dashboard/cities
   */
  getCityWiseDistribution: async () => {
    try {
      const result = await db
        .select({
          city: donors.city,
          total: count(),
        })
        .from(donors)
        .groupBy(donors.city)
        .orderBy(desc(count()))
        .limit(20);

      return result.map((r) => ({
        city: r.city,
        donor_count: Number(r.total),
      }));
    } catch (err) {
      console.error('❌ City distribution error:', err);
      throw err;
    }
  },

  /**
   * Delete a donor by ID
   */
  deleteDonor: async (donorId) => {
    try {
      await db.delete(donors).where(eq(donors.donorId, donorId));
      return true;
    } catch (err) {
      console.error('❌ Delete error:', err);
      throw err;
    }
  },

  /**
   * Update a donor
   */
  updateDonor: async (donorId, updates) => {
    try {
      const updateData = {
        ...updates,
        organs: updates.organs ? JSON.stringify(updates.organs) : undefined,
      };

      // Remove undefined keys
      Object.keys(updateData).forEach(
        (key) => updateData[key] === undefined && delete updateData[key]
      );

      await db.update(donors).set(updateData).where(eq(donors.donorId, donorId));
      return true;
    } catch (err) {
      console.error('❌ Update error:', err);
      throw err;
    }
  },

  /**
   * Create a new user account
   */
  createUser: async (user) => {
    try {
      const result = await db.insert(users).values({
        name: user.name,
        email: user.email,
        phone: user.phone,
        password: user.password,
      }).returning({ id: users.id });

      return { id: result[0]?.id };
    } catch (err) {
      console.error('❌ User creation error:', err);
      throw err;
    }
  },

  /**
   * Get user by email address
   */
  getUserByEmail: async (email) => {
    try {
      const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return result[0] || null;
    } catch (err) {
      console.error('❌ User lookup error:', err);
      throw err;
    }
  },

  /**
   * Update user password
   */
  updateUserPassword: async (email, newPassword) => {
    try {
      await db.update(users).set({ password: newPassword }).where(eq(users.email, email));
      return true;
    } catch (err) {
      console.error('❌ Password update error:', err);
      throw err;
    }
  },

  /**
   * OTP Management
   */
  saveOTP: async (email, code, expiresAt) => {
    try {
      // First clear any existing OTPs for this email
      await db.delete(otps).where(eq(otps.email, email));
      await db.insert(otps).values({ email, code, expiresAt });
      return true;
    } catch (err) {
      console.error('❌ Save OTP error:', err);
      throw err;
    }
  },

  getOTP: async (email) => {
    try {
      const result = await db.select().from(otps).where(eq(otps.email, email)).limit(1);
      return result[0] || null;
    } catch (err) {
      console.error('❌ Get OTP error:', err);
      throw err;
    }
  },

  deleteOTP: async (email) => {
    try {
      await db.delete(otps).where(eq(otps.email, email));
      return true;
    } catch (err) {
      console.error('❌ Delete OTP error:', err);
      throw err;
    }
  },
};
