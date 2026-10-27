import "dotenv/config";
import { config } from "dotenv";
import bcrypt from "bcryptjs";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import {
  appointments,
  availability,
  doctors,
  patients,
  users,
} from "../db/schema";

config({ path: ".env.local" });
config({ path: ".env" });


const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing. Copy .env.example to .env.local and fill it in.");
  process.exit(1);
}

const db = drizzle(neon(url));
const PASSWORD = "password123";

type DoctorSeed = {
  email: string;
  fullName: string;
  specialization: string;
  experienceYears: number;
  qualification: string;
  consultationFee: string;
  bio: string;
  days: number[];
  windows: { startTime: string; endTime: string }[];
};

const DOCTORS: DoctorSeed[] = [
  {
    email: "doctor@demo.com",
    fullName: "Aarav Mehta",
    specialization: "Cardiology",
    experienceYears: 12,
    qualification: "MBBS, MD (Cardiology)",
    consultationFee: "800",
    bio: "Interventional cardiologist focused on preventive heart care and post-surgery follow-ups.",
    days: [1, 2, 3, 4, 5],
    windows: [
      { startTime: "09:00", endTime: "13:00" },
      { startTime: "16:00", endTime: "19:00" },
    ],
  },
  {
    email: "nisha.rao@demo.com",
    fullName: "Nisha Rao",
    specialization: "Dermatology",
    experienceYears: 8,
    qualification: "MBBS, MD (Dermatology)",
    consultationFee: "600",
    bio: "Treats acne, pigmentation and hair loss with a focus on long-term skin health.",
    days: [1, 3, 5, 6],
    windows: [{ startTime: "10:00", endTime: "14:00" }],
  },
  {
    email: "vikram.iyer@demo.com",
    fullName: "Vikram Iyer",
    specialization: "Orthopedics",
    experienceYears: 15,
    qualification: "MBBS, MS (Orthopedics)",
    consultationFee: "900",
    bio: "Sports injury and joint replacement specialist with 15 years of surgical experience.",
    days: [2, 4, 6],
    windows: [{ startTime: "09:30", endTime: "13:30" }],
  },
  {
    email: "sneha.kapoor@demo.com",
    fullName: "Sneha Kapoor",
    specialization: "Pediatrics",
    experienceYears: 7,
    qualification: "MBBS, DCH",
    consultationFee: "500",
    bio: "Child health specialist covering vaccinations, growth tracking and newborn care.",
    days: [1, 2, 3, 4, 5],
    windows: [{ startTime: "09:00", endTime: "12:00" }],
  },
  {
    email: "rohan.gupta@demo.com",
    fullName: "Rohan Gupta",
    specialization: "General Physician",
    experienceYears: 10,
    qualification: "MBBS, MD (Internal Medicine)",
    consultationFee: "400",
    bio: "First point of contact for fevers, infections and routine health check-ups.",
    days: [1, 2, 3, 4, 5, 6],
    windows: [
      { startTime: "08:30", endTime: "12:30" },
      { startTime: "17:00", endTime: "20:00" },
    ],
  },
  {
    email: "ananya.sharma@demo.com",
    fullName: "Ananya Sharma",
    specialization: "Neurology",
    experienceYears: 9,
    qualification: "MBBS, DM (Neurology)",
    consultationFee: "1000",
    bio: "Specialises in migraine, epilepsy and movement disorders.",
    days: [3, 5],
    windows: [{ startTime: "11:00", endTime: "15:00" }],
  },
];

async function main() {
  console.log("Clearing existing demo data…");
  await db.delete(appointments);
  await db.delete(availability);
  await db.delete(doctors);
  await db.delete(patients);
  await db.delete(users);

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  console.log("Creating demo patient…");
  const [patientUser] = await db
    .insert(users)
    .values({ email: "patient@demo.com", passwordHash, role: "patient" })
    .returning({ id: users.id });

  const [patient] = await db
    .insert(patients)
    .values({
      userId: patientUser!.id,
      fullName: "Riya Sharma",
      phone: "+91 98765 43210",
      gender: "Female",
    })
    .returning({ id: patients.id });

  console.log("Creating doctors and availability…");
  const doctorIds: number[] = [];

  for (const seed of DOCTORS) {
    const [user] = await db
      .insert(users)
      .values({ email: seed.email, passwordHash, role: "doctor" })
      .returning({ id: users.id });

    const [doctor] = await db
      .insert(doctors)
      .values({
        userId: user!.id,
        fullName: seed.fullName,
        specialization: seed.specialization,
        experienceYears: seed.experienceYears,
        qualification: seed.qualification,
        consultationFee: seed.consultationFee,
        bio: seed.bio,
      })
      .returning({ id: doctors.id });

    doctorIds.push(doctor!.id);

    for (const day of seed.days) {
      for (const window of seed.windows) {
        await db.insert(availability).values({
          doctorId: doctor!.id,
          dayOfWeek: day,
          startTime: window.startTime,
          endTime: window.endTime,
          slotMinutes: 30,
        });
      }
    }
  }

  console.log("Adding one past appointment for history…");
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 3);

  await db.insert(appointments).values({
    patientId: patient!.id,
    doctorId: doctorIds[0]!,
    appointmentDate: yesterday.toISOString().slice(0, 10),
    appointmentTime: "10:00",
    status: "completed",
    reason: "Routine cardiac check-up",
  });

  console.log("Seed complete.");
  console.log("  Patient  → patient@demo.com / password123");
  console.log("  Doctor   → doctor@demo.com / password123");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
