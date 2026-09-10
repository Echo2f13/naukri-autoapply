const prisma = require('../../db/prisma.js');
prisma.appliedJob.findMany({ orderBy: { appliedAt: 'desc' }, take: 2 })
  .then(console.log)
  .finally(() => process.exit(0));
