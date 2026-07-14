require('dotenv').config();
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { Worker } = require('bullmq');

ffmpeg.setFfmpegPath(ffmpegPath);

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const worker = new Worker('video-jobs', async job => {
  const { sourceKey, outKey, edits } = job.data;
  console.log('Processing job', job.id, sourceKey);

  const tmpSource = path.join('/tmp', path.basename(sourceKey));
  const tmpOut = path.join('/tmp', `edited-${Date.now()}.mp4`);

  // download source
  const obj = await s3.getObject({ Bucket: process.env.S3_BUCKET, Key: sourceKey }).promise();
  fs.writeFileSync(tmpSource, obj.Body);

  // build ffmpeg command
  await new Promise((resolve, reject) => {
    let cmd = ffmpeg(tmpSource).outputOptions('-movflags frag_keyframe+empty_moov').format('mp4');

    if (edits && edits.trim) {
      cmd = cmd.setStartTime(edits.trim.start).setDuration(edits.trim.duration);
    }

    // watermark example (edits.watermark should be an S3 key or local path)
    if (edits && edits.watermark) {
      const watermarkLocal = path.join('/tmp', path.basename(edits.watermark));
      // download watermark if it's an S3 key (very simple heuristic)
      if (edits.watermark.startsWith('s3://') || edits.watermark.startsWith('uploads/') || edits.watermark.startsWith('outputs/')) {
        // assume key
        const key = edits.watermark.replace('s3://', '');
        const wm = s3.getObject({ Bucket: process.env.S3_BUCKET, Key: key }).promise();
        wm.then(data => fs.writeFileSync(watermarkLocal, data.Body)).catch(() => {});
      }
      cmd = cmd.input(watermarkLocal).complexFilter([{
        filter: 'overlay',
        options: { x: 10, y: 10 }
      }]);
    }

    cmd.on('end', resolve).on('error', reject).save(tmpOut);
  });

  // upload output
  await s3.upload({ Bucket: process.env.S3_BUCKET, Key: outKey, Body: fs.createReadStream(tmpOut), ContentType: 'video/mp4' }).promise();

  // cleanup
  try { fs.unlinkSync(tmpSource); } catch(e){}
  try { fs.unlinkSync(tmpOut); } catch(e){}

  console.log('Job finished', job.id, outKey);
  return { outKey };
}, { connection: { url: redisUrl } });

worker.on('error', err => console.error('Worker error', err));
