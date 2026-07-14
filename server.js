require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const { Queue } = require('bullmq');
const jwt = require('jsonwebtoken');

const upload = multer({ dest: '/tmp/uploads' });
const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

if (!process.env.S3_BUCKET) {
  console.warn('Warning: S3_BUCKET not set. Configure .env or environment variables.');
}

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  s3ForcePathStyle: !!process.env.S3_ENDPOINT // useful for MinIO
});

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const videoQueue = new Queue('video-jobs', { connection: { url: redisUrl } });

app.use(express.json());

// Simple auth & RBAC middleware
function authenticate(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Malformed Authorization header' });
  try {
    const payload = jwt.verify(parts[1], JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function authorize(roles = []) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.length === 0) return next();
    if (roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

// Demo-only helper: mint a token for a user (username + role)
app.post('/auth/token', (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const token = jwt.sign({ userId, role: role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// Presign PUT URL for direct uploads
app.post('/presign', authenticate, authorize(['user','admin']), async (req, res) => {
  try {
    const { filename, contentType } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const key = `uploads/${Date.now()}-${path.basename(filename)}`;
    const params = { Bucket: process.env.S3_BUCKET, Key: key, ContentType: contentType || 'application/octet-stream' };
    const url = await s3.getSignedUrlPromise('putObject', params);
    // create a job placeholder in the queue with minimal data so we can track by jobId later if desired
    // The client should call the server /job/create or /upload/complete to enqueue processing after upload, but we'll accept either flow.
    res.json({ uploadUrl: url, key });
  } catch (err) {
    console.error('presign error', err);
    res.status(500).json({ error: 'presign failed' });
  }
});

// Endpoint to create a processing job for an existing S3 key (used after direct upload)
app.post('/jobs', authenticate, authorize(['user','admin']), async (req, res) => {
  try {
    const { key, edits } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const outKey = key.replace('uploads/', 'outputs/');
    const job = await videoQueue.add('edit', { sourceKey: key, outKey, edits, userId: req.user.userId });
    res.status(202).json({ message: 'Job queued', jobId: job.id });
  } catch (err) {
    console.error('jobs create error', err);
    res.status(500).json({ error: 'job queue failed' });
  }
});

// Old upload endpoint (server-mediated). Kept for convenience but large files should use presign flow.
app.post('/upload', authenticate, authorize(['user','admin']), upload.single('video'), async (req, res) => {
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
      userId: req.user.userId || null
    });

    // Clean up local temp
    fs.unlink(localPath, () => {});

    res.status(202).json({ message: 'Video queued for processing', jobId: job.id });
  } catch (err) {
    console.error('Upload error', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Job status endpoint
app.get('/jobs/:id', authenticate, async (req, res) => {
  try {
    const job = await videoQueue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Authorization: only owner or admin can view
    const jobUser = job.data.userId;
    if (req.user.role !== 'admin' && jobUser && req.user.userId !== jobUser) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const state = await job.getState();
    const result = job.returnvalue || null;
    let resultUrl = null;
    if (state === 'completed' && result && result.outKey) {
      // generate a short-lived signed URL for the result
      const params = { Bucket: process.env.S3_BUCKET, Key: result.outKey, Expires: 60 * 60 }; // 1 hour
      try {
        resultUrl = await s3.getSignedUrlPromise('getObject', params);
      } catch (e) {
        console.warn('Signed URL generation failed', e);
      }
    }

    res.json({ id: job.id, state, progress: job.progress, result, resultUrl, data: job.data });
  } catch (err) {
    console.error('job status error', err);
    res.status(500).json({ error: 'Could not get job status' });
  }
});

app.get('/', (req, res) => res.send('Video processing scaffold running'));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
