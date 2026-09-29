import { prisma } from "../lib/prisma.js";

const email = process.argv[2]?.toLowerCase();

if (!email) {
    console.error("Usage: npm run make-admin -- <email>");
    process.exit(1);
}

try {
    const user = await prisma.user.update({ where: { email }, data: { role: "ADMIN" } });
    console.log(`${user.email} is now an ADMIN`);
} catch {
    console.error(`No user found with email ${email}`);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
