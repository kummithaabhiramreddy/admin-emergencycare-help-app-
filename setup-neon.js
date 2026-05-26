import 'dotenv/config';
import { db } from './db/client.js';
import { sql } from 'drizzle-orm';

async function setup() {
  console.log('🚀 Starting Neon Database Setup...');
  
  try {
    // 1. Create Donors Table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS donors (
        id SERIAL PRIMARY KEY,
        donorid VARCHAR(100),
        name VARCHAR(255) NOT NULL,
        dob VARCHAR(50),
        bloodgroup VARCHAR(10),
        type VARCHAR(50),
        organs TEXT,
        city VARCHAR(100),
        phone VARCHAR(20),
        email VARCHAR(255),
        biometric TEXT,
        registeredon VARCHAR(100),
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        donated_count INTEGER DEFAULT 0 NOT NULL,
        donated_detail TEXT DEFAULT '',
        received_count INTEGER DEFAULT 0 NOT NULL,
        received_detail TEXT DEFAULT ''
      );
    `);
    console.log('✅ Donors table ensured.');

    // 2. Create Users Table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(20),
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);`);
    console.log('✅ Users table ensured.');

    // 3. Create Emergency Requests Table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS emergency_requests (
        id SERIAL PRIMARY KEY,
        donor_id VARCHAR(100) NOT NULL,
        requester_name VARCHAR(255) NOT NULL,
        request_type VARCHAR(50),
        blood_group VARCHAR(10),
        organ_type TEXT,
        details TEXT,
        completed_status VARCHAR(50) DEFAULT 'Pending',
        completed_admin_name VARCHAR(255),
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_req_donor ON emergency_requests (donor_id);`);
    console.log('✅ Emergency Requests table ensured.');

    // 4. Create Emergency Care Table (alias for compatibility)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS emergency_care (
        id SERIAL PRIMARY KEY,
        donor_id VARCHAR(100) NOT NULL,
        requester_name VARCHAR(255) NOT NULL,
        request_type VARCHAR(50),
        blood_group VARCHAR(10),
        organ_type TEXT,
        details TEXT,
        completed_status VARCHAR(50) DEFAULT 'Pending',
        completed_admin_name VARCHAR(255),
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ec_donor ON emergency_care (donor_id);`);
    console.log('✅ Emergency Care table ensured.');

    // 5. Create OTPs Table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS otps (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        code VARCHAR(6) NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_otp_email ON otps (email);`);
    console.log('✅ OTPs table ensured.');

    console.log('\n✨ Database setup complete! All tables are ready in Neon.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Setup failed:', err);
    process.exit(1);
  }
}

setup();
