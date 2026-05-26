import { db } from './client.js';
import { donors, users, emergencyRequests, emergencyCare, otps } from './schema.js';
import { eq, desc, sql, ilike, or, and } from 'drizzle-orm';

/* ══════════════════════════════════════════════
   DONOR OPERATIONS
   ══════════════════════════════════════════════ */

async function getAllDonors() {
  const result = await db.select().from(donors).orderBy(desc(donors.timestamp));
  return result.map(d => ({
    ...d,
    organs: d.organs ? (typeof d.organs === 'string' ? d.organs.split(',').map(o => o.trim()) : d.organs) : [],
  }));
}

async function saveDonor(record) {
  const result = await db.insert(donors).values({
    donorId: record.donorId,
    name: record.name,
    dob: record.dob || '',
    bloodgroup: record.bloodgroup || '',
    type: record.type || '',
    organs: Array.isArray(record.organs) ? record.organs.join(',') : (record.organs || ''),
    city: record.city || '',
    phone: record.phone || '',
    email: record.email || '',
    biometric: record.biometric || null,
    registeredOn: record.registeredOn || '',
    timestamp: record.timestamp || Date.now(),
    donated_count: record.donated_count || 0,
    donated_detail: record.donated_detail || '',
    received_count: record.received_count || 0,
    received_detail: record.received_detail || '',
  }).returning({ id: donors.id });
  return result[0];
}

async function updateDonor(donorId, updates) {
  const updateData = {};
  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.city !== undefined) updateData.city = updates.city;
  if (updates.donated_count !== undefined) updateData.donated_count = updates.donated_count;
  if (updates.donated_detail !== undefined) updateData.donated_detail = updates.donated_detail;
  if (updates.timestamp !== undefined) updateData.timestamp = updates.timestamp;
  if (updates.registeredOn !== undefined) updateData.registeredOn = updates.registeredOn;
  if (updates.received_count !== undefined) updateData.received_count = updates.received_count;
  if (updates.received_detail !== undefined) updateData.received_detail = updates.received_detail;

  await db.update(donors).set(updateData).where(eq(donors.donorId, donorId));
}

async function deleteDonor(donorId) {
  await db.delete(donors).where(eq(donors.donorId, donorId));
}

async function getDonorsByBloodGroup(bloodGroup) {
  return await db.select().from(donors).where(eq(donors.bloodgroup, bloodGroup));
}

async function getDonorsByCity(city) {
  return await db.select().from(donors).where(ilike(donors.city, `%${city}%`));
}

async function getRecentDonors(limit = 10) {
  return await db.select().from(donors).orderBy(desc(donors.timestamp)).limit(limit);
}

/* ══════════════════════════════════════════════
   SEARCH OPERATIONS
   ══════════════════════════════════════════════ */

async function searchBloodDonors(query) {
  const allDonors = await getAllDonors();
  return allDonors.filter(d => {
    if (d.type !== 'Blood' && d.type !== 'Both') return false;
    if (query.bloodGroups) {
      const groups = query.bloodGroups.split(',').map(g => g.trim());
      if (!groups.includes(d.bloodgroup)) return false;
    }
    if (query.name && !d.name.toLowerCase().includes(query.name.toLowerCase())) return false;
    if (query.city && !d.city.toLowerCase().includes(query.city.toLowerCase())) return false;
    return true;
  });
}

async function searchOrganDonors(query) {
  const allDonors = await getAllDonors();
  return allDonors.filter(d => {
    if (d.type !== 'Organ' && d.type !== 'Both') return false;
    if (query.organs) {
      const searchOrgans = query.organs.split(',').map(o => o.trim().toLowerCase());
      const donorOrgans = Array.isArray(d.organs) ? d.organs.map(o => o.toLowerCase()) : [];
      if (!searchOrgans.some(so => donorOrgans.some(do_ => do_.includes(so)))) return false;
    }
    if (query.name && !d.name.toLowerCase().includes(query.name.toLowerCase())) return false;
    if (query.city && !d.city.toLowerCase().includes(query.city.toLowerCase())) return false;
    return true;
  });
}

/* ══════════════════════════════════════════════
   EMERGENCY REQUEST OPERATIONS
   ══════════════════════════════════════════════ */

async function logEmergencyRequest(data) {
  await db.insert(emergencyRequests).values({
    donorId: data.donorId,
    requesterName: data.requesterName,
    requestType: data.requestType || 'Blood',
    bloodGroup: data.bloodGroup || null,
    organType: data.organType || null,
    details: typeof data.details === 'object' ? JSON.stringify(data.details) : (data.details || ''),
    timestamp: Date.now(),
  });
}

async function getAllRequests() {
  const result = await db.select().from(emergencyRequests).orderBy(desc(emergencyRequests.timestamp));
  return result.map(r => ({
    id: r.id,
    donorId: r.donorId,
    requesterName: r.requesterName,
    requestType: r.requestType,
    bloodGroup: r.bloodGroup,
    organType: r.organType,
    details: r.details,
    timestamp: r.timestamp,
    createdAt: r.createdAt,
  }));
}

async function updateEmergencyRequest(id, updates) {
  // updates is expected to have { details: string } or similar
  await db.update(emergencyRequests).set(updates).where(eq(emergencyRequests.id, id));
}

/* ══════════════════════════════════════════════
   DONATION EVENT OPERATIONS
   ══════════════════════════════════════════════ */

async function logDonationEvent(data) {
  const allDonors = await getAllDonors();
  const donor = allDonors.find(d => d.donorId === data.donorId);
  if (!donor) return false;

  const donationType = data.type === 'Blood'
    ? `Blood (${data.bloodGroup || donor.bloodgroup || 'N/A'})`
    : data.type === 'Both'
      ? `Blood (${data.bloodGroup || donor.bloodgroup || 'N/A'}) & Organ (${data.organType || ''})`
      : `Organ (${data.organType || ''})`;

  const newCount = (donor.donated_count || 0) + 1;
  const newDetail = donor.donated_detail ? `${donor.donated_detail}, ${donationType}` : donationType;

  await updateDonor(data.donorId, {
    donated_count: newCount,
    donated_detail: newDetail,
    timestamp: Date.now(),
  });

  return true;
}

/* ══════════════════════════════════════════════
   USER / AUTH OPERATIONS
   ══════════════════════════════════════════════ */

async function getUserByEmail(email) {
  const result = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).limit(1);
  return result[0] || null;
}

async function createUser(data) {
  const result = await db.insert(users).values({
    name: data.name,
    email: data.email.toLowerCase().trim(),
    phone: data.phone || '',
    password: data.password,
  }).returning({ id: users.id });
  return result[0];
}

async function updateUserPassword(email, hashedPassword) {
  await db.update(users).set({ password: hashedPassword }).where(eq(users.email, email.toLowerCase().trim()));
}

/* ══════════════════════════════════════════════
   OTP OPERATIONS
   ══════════════════════════════════════════════ */

async function saveOTP(email, code, expiresAt) {
  // Delete any existing OTP for this email first
  await db.delete(otps).where(eq(otps.email, email.toLowerCase().trim()));
  await db.insert(otps).values({
    email: email.toLowerCase().trim(),
    code,
    expiresAt,
  });
}

async function getOTP(email) {
  const result = await db.select().from(otps).where(eq(otps.email, email.toLowerCase().trim())).limit(1);
  return result[0] || null;
}

async function deleteOTP(email) {
  await db.delete(otps).where(eq(otps.email, email.toLowerCase().trim()));
}

/* ══════════════════════════════════════════════
   STATISTICS / ANALYTICS
   ══════════════════════════════════════════════ */

async function getStats() {
  const allDonors = await getAllDonors();
  return {
    total_donors: allDonors.length,
    database: 'neon-postgresql',
  };
}

async function countByType() {
  const allDonors = await getAllDonors();
  const counts = {};
  allDonors.forEach(d => {
    const t = d.type || 'Unknown';
    counts[t] = (counts[t] || 0) + 1;
  });
  return counts;
}

async function countByBloodGroup() {
  const allDonors = await getAllDonors();
  const counts = {};
  allDonors.forEach(d => {
    const bg = d.bloodgroup || 'Unknown';
    counts[bg] = (counts[bg] || 0) + 1;
  });
  return counts;
}

async function getBloodGroupAvailability() {
  const allDonors = await getAllDonors();
  const groups = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
  return groups.map(g => ({
    blood_group: g,
    count: allDonors.filter(d => d.bloodgroup === g && (d.type === 'Blood' || d.type === 'Both')).length,
  }));
}

async function getDonationTypeBreakdown() {
  const allDonors = await getAllDonors();
  return {
    Blood: allDonors.filter(d => d.type === 'Blood').length,
    Organ: allDonors.filter(d => d.type === 'Organ').length,
    Both: allDonors.filter(d => d.type === 'Both').length,
  };
}

async function getCityWiseDistribution() {
  const allDonors = await getAllDonors();
  const counts = {};
  allDonors.forEach(d => {
    const c = d.city || 'Unknown';
    counts[c] = (counts[c] || 0) + 1;
  });
  return Object.entries(counts).map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count);
}

/* ══════════════════════════════════════════════
   EXPORT ALL
   ══════════════════════════════════════════════ */

const dbRepo = {
  // Donors
  getAllDonors,
  saveDonor,
  updateDonor,
  deleteDonor,
  getDonorsByBloodGroup,
  getDonorsByCity,
  getRecentDonors,
  // Search
  searchBloodDonors,
  searchOrganDonors,
  // Emergency Requests
  logEmergencyRequest,
  getAllRequests,
  updateEmergencyRequest,
  // Donations
  logDonationEvent,
  // Users
  getUserByEmail,
  createUser,
  updateUserPassword,
  // OTPs
  saveOTP,
  getOTP,
  deleteOTP,
  // Stats
  getStats,
  countByType,
  countByBloodGroup,
  getBloodGroupAvailability,
  getDonationTypeBreakdown,
  getCityWiseDistribution,
};

export default dbRepo;
