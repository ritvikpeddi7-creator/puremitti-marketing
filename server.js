require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const { Queue } = require('bullmq');

const upload = multer({ dest: '/tmp/uploads' });
const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.S3_BUCKET) {
  console.warn('Warning: S3_BUCKET not set. Configure .env or environment variables.');
}

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const videoQueue = new Queue('video-jobs', { connection: { url: redisUrl } });

app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const localPath = req.file.path;
    const key = `uploads/${Date.now()}-${req.file.originalname}`;

    // Upload to S3
    const uploadParams = {
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: req.file.mimetype
    };

    await s3.upload(uploadParams).promise();

    // Create a job with default edits (trim first 30s) - client can override via JSON body
    const edits = req.body.edits ? JSON.parse(req.body.edits) : { trim: { start: 0, duration: 30 } };
    const outKey = key.replace('uploads/', 'outputs/');

    const job = await videoQueue.add('edit', {
      sourceKey: key,
      outKey,
      edits,
      userId: req.body.userId || null
    });

    // Clean up local temp
    fs.unlink(localPath, () => {});

    res.status(202).json({ message: 'Video queued for processing', jobId: job.id });
  } catch (err) {
    console.error('Upload error', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/', (req, res) => res.send('Video processing scaffold running'));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
