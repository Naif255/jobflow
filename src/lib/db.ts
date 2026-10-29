import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret, isEncrypted } from "@/lib/crypto";

/** Encrypt `password` in a write payload, whether given as a string or `{ set }`. */
function encryptPassword<T>(data: T): T {
  if (!data || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  const pw = record.password;
  const seal = (v: string) => (isEncrypted(v) ? v : encryptSecret(v));
  if (typeof pw === "string") return { ...record, password: seal(pw) } as T;
  if (pw && typeof pw === "object" && typeof (pw as { set?: unknown }).set === "string") {
    return { ...record, password: { set: seal((pw as { set: string }).set) } } as T;
  }
  return data;
}

function createClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  // PortalAccount passwords are always encrypted on write. Reads return ciphertext;
  // call decryptSecret() only at the point of use.
  return new PrismaClient({ adapter }).$extends({
    query: {
      portalAccount: {
        create: ({ args, query }) => query({ ...args, data: encryptPassword(args.data) }),
        update: ({ args, query }) => query({ ...args, data: encryptPassword(args.data) }),
        updateMany: ({ args, query }) => query({ ...args, data: encryptPassword(args.data) }),
        updateManyAndReturn: ({ args, query }) => query({ ...args, data: encryptPassword(args.data) }),
        upsert: ({ args, query }) =>
          query({ ...args, create: encryptPassword(args.create), update: encryptPassword(args.update) }),
        createMany: ({ args, query }) =>
          query({
            ...args,
            data: Array.isArray(args.data) ? args.data.map(encryptPassword) : encryptPassword(args.data),
          }),
        createManyAndReturn: ({ args, query }) =>
          query({
            ...args,
            data: Array.isArray(args.data) ? args.data.map(encryptPassword) : encryptPassword(args.data),
          }),
      },
    },
  });
}

type DbClient = ReturnType<typeof createClient>;

const globalForPrisma = globalThis as unknown as { prisma?: DbClient };

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
