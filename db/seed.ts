import "dotenv/config";
import { config } from "dotenv";
import bcrypt from "bcryptjs";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import {
  appointments,
  availability,
  availabilityDates,
  doctors,
  patients,
  users,
} from "../db/schema";
import { streamSpacing } from "../lib/schedule";

config({ path: ".env.local" });
config({ path: ".env" });


const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing. Copy .env.example to .env.local and fill it in.");
  process.exit(1);
}

const db = drizzle(neon(url));
const PASSWORD = "password123";

/**
 * One published schedule block.
 *
 * A block is weekly (it names a weekday) or date-based (it lists the dates it
 * opens on). One listed date is a single visit day; several are a recurring
 * series.
 */
type BlockSeed = {
  readonly schedulingType: "wave" | "stream";
  /** 0 = Sunday ... 6 = Saturday. Null for a date-based block. */
  readonly dayOfWeek: number | null;
  readonly dates: readonly string[];
  readonly startTime: string;
  readonly endTime: string;
  readonly slotMinutes: number;
  readonly capacity: number;
};

type DoctorSeed = {
  email: string;
  fullName: string;
  specialization: string;
  experienceYears: number;
  qualification: string;
  consultationFee: string;
  bio: string;
  blocks: BlockSeed[];
};

/** A wave: patients share a slot, so the capacity counts patients per slot. */
function wave(
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  capacity = 3,
  slotMinutes = 30,
): BlockSeed {
  return {
    schedulingType: "wave",
    dayOfWeek,
    dates: [],
    startTime,
    endTime,
    slotMinutes,
    capacity,
  };
}

/**
 * A stream: the window books as one start–end item, so the capacity counts
 * patients in the window and the spacing is derived at publish time.
 */
function stream(
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  capacity: number,
): BlockSeed {
  return {
    schedulingType: "stream",
    dayOfWeek,
    dates: [],
    startTime,
    endTime,
    slotMinutes: streamSpacing(startTime, endTime, capacity),
    capacity,
  };
}

/** The same, but opening on an explicit list of dates. */
function dated(
  dates: readonly string[],
  schedulingType: "wave" | "stream",
  startTime: string,
  endTime: string,
  capacity: number,
  slotMinutes = 30,
): BlockSeed {
  return {
    schedulingType,
    dayOfWeek: null,
    dates,
    startTime,
    endTime,
    slotMinutes:
      schedulingType === "wave"
        ? slotMinutes
        : streamSpacing(startTime, endTime, capacity),
    capacity,
  };
}

const DOCTORS: DoctorSeed[] = [
  {
    email: "doctor@demo.com",
    fullName: "Aarav Mehta",
    specialization: "Cardiology",
    experienceYears: 12,
    qualification: "MBBS, MD (Cardiology)",
    consultationFee: "800",
    bio: "Interventional cardiologist focused on preventive heart care and post-surgery follow-ups.",
    blocks: [
      wave(1, "09:00", "13:00", 3),
      wave(3, "09:00", "13:00", 3),
      stream(5, "16:00", "19:00", 5),
      // A recurring series on Tuesdays and a single visit day on a Saturday,
      // so both kinds of dated block are there to try.
      dated(upcomingDates(2, 3), "wave", "10:00", "12:00", 2),
      dated(upcomingDates(6, 1), "stream", "09:00", "11:00", 4),
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
    blocks: [
      wave(1, "10:00", "14:00", 2),
      wave(3, "10:00", "14:00", 2),
      stream(5, "10:00", "14:00", 4),
      wave(6, "10:00", "13:00", 3),
    ],
  },
  {
    email: "vikram.iyer@demo.com",
    fullName: "Vikram Iyer",
    specialization: "Orthopedics",
    experienceYears: 15,
    qualification: "MBBS, MS (Orthopedics)",
    consultationFee: "900",
    bio: "Sports injury and joint replacement specialist with 15 years of surgical experience.",
    blocks: [wave(2, "09:30", "13:30", 2), wave(4, "09:30", "13:30", 2), wave(6, "09:30", "12:30", 2)],
  },
  {
    email: "sneha.kapoor@demo.com",
    fullName: "Sneha Kapoor",
    specialization: "Pediatrics",
    experienceYears: 7,
    qualification: "MBBS, DCH",
    consultationFee: "500",
    bio: "Child health specialist covering vaccinations, growth tracking and newborn care.",
    blocks: [wave(1, "09:00", "12:00", 4), wave(2, "09:00", "12:00", 4), wave(3, "09:00", "12:00", 4)],
  },
  {
    email: "rohan.gupta@demo.com",
    fullName: "Rohan Gupta",
    specialization: "General Physician",
    experienceYears: 10,
    qualification: "MBBS, MD (Internal Medicine)",
    consultationFee: "400",
    bio: "First point of contact for fevers, infections and routine health check-ups.",
    blocks: [
      wave(1, "08:30", "12:30", 3),
      wave(2, "08:30", "12:30", 3),
      wave(3, "08:30", "12:30", 3),
      wave(4, "08:30", "12:30", 3),
      wave(5, "08:30", "12:30", 3),
      stream(6, "17:00", "20:00", 6),
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
    blocks: [wave(3, "11:00", "15:00", 2), wave(5, "11:00", "15:00", 2)],
  },
];

/** The next `count` dates that fall on the given weekday, starting tomorrow. */
function upcomingDates(dayOfWeek: number, count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);

  while (dates.length < count) {
    if (cursor.getDay() === dayOfWeek) dates.push(localDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

/** "2026-11-12" in the machine's own calendar, not UTC's. */
function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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

    for (const block of seed.blocks) {
      const [created] = await db
        .insert(availability)
        .values({
          doctorId: doctor!.id,
          schedulingType: block.schedulingType,
          dayOfWeek: block.dayOfWeek,
          startTime: block.startTime,
          endTime: block.endTime,
          slotMinutes: block.slotMinutes,
          capacity: block.capacity,
        })
        .returning({ id: availability.id });

      if (block.dates.length > 0) {
        await db.insert(availabilityDates).values(
          block.dates.map((date) => ({ availabilityId: created!.id, date })),
        );
      }
    }
  }

  console.log("Adding past appointments for history…");
  const daysAgo = (count: number) => {
    const date = new Date();
    date.setDate(date.getDate() - count);
    return localDate(date);
  };

  await db.insert(appointments).values([
    {
      patientId: patient!.id,
      doctorId: doctorIds[0]!,
      appointmentDate: daysAgo(3),
      appointmentTime: "10:00",
      seatNumber: 1,
      status: "completed",
      reason: "Routine cardiac check-up",
    },
    {
      patientId: patient!.id,
      doctorId: doctorIds[0]!,
      appointmentDate: daysAgo(5),
      appointmentTime: "16:00",
      seatNumber: 1,
      status: "no_show",
      reason: "Follow-up for palpitations",
    },
  ]);

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
