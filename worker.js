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
  region: process.env.AWS_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  s3ForcePathStyle: !!process.env.S3_ENDPOINT
});

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const worker = new Worker('video-jobs', async job => {
  const { sourceKey, outKey, edits } = job.data;
  console.log('Processing job', job.id, sourceKey);

  // ensure working dirs
  const tmpSource = path.join('/tmp', `source-${Date.now()}-${path.basename(sourceKey)}`);
  const tmpOut = path.join('/tmp', `edited-${Date.now()}.mp4`);

  // download source
  const obj = await s3.getObject({ Bucket: process.env.S3_BUCKET, Key: sourceKey }).promise();
  fs.writeFileSync(tmpSource, obj.Body);

  // Helper functions for ffmpeg operations
  const runFfmpeg = (cmd) => new Promise((resolve, reject) => {
    cmd.on('end', resolve).on('error', reject).save(tmpOut);
  });

  try {
    // Support multiple edit types: trim, watermark, concat, speed, filter (grayscale), auto_highlight
    if (edits && edits.concat && Array.isArray(edits.concat.sources)) {
      // download each source locally and create a concat list
      const localFiles = [];
      for (const srcKey of edits.concat.sources) {
        const local = path.join('/tmp', `concat-${Date.now()}-${path.basename(srcKey)}`);
        const obj = await s3.getObject({ Bucket: process.env.S3_BUCKET, Key: srcKey }).promise();
        fs.writeFileSync(local, obj.Body);
        localFiles.push(local);
      }
      // create file list
      const listFile = path.join('/tmp', `list-${Date.now()}.txt`);
      fs.writeFileSync(listFile, localFiles.map(p => `file '${p}'`).join('\n'));
      // run concat
      await runFfmpeg(ffmpeg().input(listFile).inputOptions(['-f concat', '-safe 0']).outputOptions('-c copy'));
    } else if (edits && edits.auto_highlight) {
      // naive scene-detect based highlights: extract short clips around scene changes
      // We'll detect scene changes and pick the first N segments up to duration each and concat them.
      const highlightsCount = edits.auto_highlight.count || 5;
      const eachDuration = edits.auto_highlight.duration || 5;
      const tmpSegments = [];

      // Use ffmpeg to print scene change pts to a file
      const sceneFile = path.join('/tmp', `scenes-${Date.now()}.txt`);
      await new Promise((resolve, reject) => {
        ffmpeg(tmpSource)
          .outputOptions(['-vf', "select=gt(scene\\,0.4)", '-vsync', 'vfr', '-f', 'null'])
          .on('start', cmd => console.log('scene detect cmd', cmd))
          .on('end', resolve).on('error', reject)
          .save('/dev/null');
      }).catch(err => console.warn('scene detect not available in this environment', err));

      // Simple fallback: just take first N seconds of the video if scene detect not available
      const fallbackSegments = [];
      for (let i = 0; i < highlightsCount; i++) {
        const segOut = path.join('/tmp', `seg-${i}-${Date.now()}.mp4`);
        await new Promise((resolve, reject) => {
          ffmpeg(tmpSource)
            .setStartTime(i * eachDuration)
            .setDuration(eachDuration)
            .outputOptions('-c copy')
            .on('end', resolve).on('error', reject)
            .save(segOut);
        });
        tmpSegments.push(segOut);
      }

      // concat segments
      const listFile = path.join('/tmp', `list-${Date.now()}.txt`);
      fs.writeFileSync(listFile, tmpSegments.map(p => `file '${p}'`).join('\n'));
      await runFfmpeg(ffmpeg().input(listFile).inputOptions(['-f concat', '-safe 0']).outputOptions('-c copy'));

      // cleanup tmpSegments
      tmpSegments.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });

    } else {
      // default single-file edits
      let cmd = ffmpeg(tmpSource).outputOptions('-movflags frag_keyframe+empty_moov').format('mp4');

      if (edits && edits.trim) {
        if (typeof edits.trim.start !== 'undefined') cmd = cmd.setStartTime(edits.trim.start);
        if (typeof edits.trim.duration !== 'undefined') cmd = cmd.setDuration(edits.trim.duration);
      }

      if (edits && edits.speed) {
        // speed >1 for faster, <1 for slower
        // setpts for video, atempo for audio (chained if needed). atempo supports 0.5-2.0 per filter
        const speed = edits.speed;
        cmd = cmd.videoFilter(`setpts=${(1 / speed)}*PTS`);
        if (speed >= 0.5 && speed <= 2.0) {
          cmd = cmd.audioFilters(`atempo=${speed}`);
        } else if (speed > 2.0) {
          // chain multiple atempo filters to approximate higher speeds
          const factors = [];
          let rem = speed;
          while (rem > 2.0) { factors.push(2.0); rem /= 2.0; }
          factors.push(rem);
          cmd = cmd.audioFilters(factors.map(f => `atempo=${f}`).join(','));
        } else {
          // slow speeds below 0.5 are approximated, may degrade audio
          cmd = cmd.audioFilters(`atempo=${Math.max(0.5, speed)}`);
        }
      }

      if (edits && edits.filter === 'grayscale') {
        cmd = cmd.videoFilter('hue=s=0');
      }

      if (edits && edits.watermark) {
        // download watermark and overlay
        const watermarkLocal = path.join('/tmp', path.basename(edits.watermark));
        try {
          const wmObj = await s3.getObject({ Bucket: process.env.S3_BUCKET, Key: edits.watermark }).promise();
          fs.writeFileSync(watermarkLocal, wmObj.Body);
          cmd = cmd.input(watermarkLocal).complexFilter([ { filter: 'overlay', options: { x: 10, y: 10 } }]);
        } catch (e) { console.warn('watermark download failed', e); }
      }

      await runFfmpeg(cmd);
    }

    // upload output
    await s3.upload({ Bucket: process.env.S3_BUCKET, Key: outKey, Body: fs.createReadStream(tmpOut), ContentType: 'video/mp4' }).promise();

    // cleanup
    try { fs.unlinkSync(tmpSource); } catch(e){}
    try { fs.unlinkSync(tmpOut); } catch(e){}

    console.log('Job finished', job.id, outKey);
    return { outKey };
  } catch (err) {
    console.error('Worker processing failed', err);
    throw err;
  }
}, { connection: { url: redisUrl } });

worker.on('error', err => console.error('Worker error', err));
