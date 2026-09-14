const { S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'ru-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true, // Beget требует path-style
});

// Префикс ключей моделей внутри бакета: s3://bucket/models/{offer_id}.zip
const MODELS_PREFIX = process.env.S3_MODELS_PREFIX || 'models/';

module.exports = { s3, BUCKET: process.env.S3_BUCKET, PREFIX: process.env.S3_PREFIX || '', MODELS_PREFIX };
