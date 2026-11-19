const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to clean extracted Facebook CDN URLs
function cleanFbUrl(rawUrl) {
  if (!rawUrl) return null;
  let url = rawUrl
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .trim();
  if (url.startsWith('"') && url.endsWith('"')) {
    url = url.substring(1, url.length - 1);
  }
  return url;
}

// Scrape Facebook video details
async function getFbVideoData(targetUrl) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  };

  try {
    const response = await axios.get(targetUrl, {
      headers,
      maxRedirects: 5,
      timeout: 10000,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Metadata extraction
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').text().replace(/ \| Facebook$/i, '').trim() ||
      'فيديو فيسبوك مميز';

    const thumbnail =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=600&auto=format&fit=crop&q=80';

    // Regex searches for HD & SD video URLs in Facebook's embedded JSON / GraphQL data
    let hdUrl = null;
    let sdUrl = null;

    const hdMatches = [
      /browser_native_hd_url["']?\s*:\s*["'](https:[^"']+)["']/i,
      /playable_url_quality_hd["']?\s*:\s*["'](https:[^"']+)["']/i,
      /"hd_src["']?\s*:\s*["'](https:[^"']+)["']/i,
    ];

    const sdMatches = [
      /browser_native_sd_url["']?\s*:\s*["'](https:[^"']+)["']/i,
      /playable_url["']?\s*:\s*["'](https:[^"']+)["']/i,
      /"sd_src["']?\s*:\s*["'](https:[^"']+)["']/i,
    ];

    for (const regex of hdMatches) {
      const match = html.match(regex);
      if (match && match[1]) {
        hdUrl = cleanFbUrl(match[1]);
        break;
      }
    }

    for (const regex of sdMatches) {
      const match = html.match(regex);
      if (match && match[1]) {
        sdUrl = cleanFbUrl(match[1]);
        break;
      }
    }

    // Direct og:video fallback
    if (!hdUrl && !sdUrl) {
      const ogVideo = $('meta[property="og:video"]').attr('content') ||
                      $('meta[property="og:video:url"]').attr('content') ||
                      $('meta[property="og:video:secure_url"]').attr('content');
      if (ogVideo) {
        sdUrl = cleanFbUrl(ogVideo);
      }
    }

    if (hdUrl || sdUrl) {
      return {
        success: true,
        title,
        thumbnail,
        hdUrl,
        sdUrl: sdUrl || hdUrl,
      };
    }
  } catch (err) {
    console.warn('Direct scrape failed, attempting secondary API fallback:', err.message);
  }

  // Fallback API if Facebook server rejects direct request
  try {
    const fallbackRes = await axios.post(
      'https://snapsave.app/action.php?lang=en',
      new URLSearchParams({ url: targetUrl }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        timeout: 8000,
      }
    );

    if (fallbackRes.data && typeof fallbackRes.data === 'string') {
      const dataStr = fallbackRes.data;
      const downloadMatches = dataStr.match(/https:\/\/[^"'\s]+\.fbcdn\.net[^"'\s]+/g);
      if (downloadMatches && downloadMatches.length > 0) {
        return {
          success: true,
          title: 'فيديو فيسبوك عالي الدقة',
          thumbnail: 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=600&auto=format&fit=crop&q=80',
          hdUrl: downloadMatches[0],
          sdUrl: downloadMatches[1] || downloadMatches[0],
        };
      }
    }
  } catch (err2) {
    console.warn('Secondary fallback failed:', err2.message);
  }

  throw new Error('تعذر العثور على روابط الفيديو. تأكد من أن الفيديو عام (Public) وليس داخل مجموعة خاصة.');
}

// Endpoint: Fetch video information
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ success: false, message: 'يرجى إدخال رابط فيديو صالح من فيسبوك' });
  }

  const cleanUrl = url.trim();
  const isValidFb = /facebook\.com|fb\.watch|fb\.com/i.test(cleanUrl);
  if (!isValidFb) {
    return res.status(400).json({ success: false, message: 'الرابط غير صحيح. يرجى إدخال رابط فيسبوك صحيح.' });
  }

  try {
    const data = await getFbVideoData(cleanUrl);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint: Stream / Download video file directly to force download dialog
app.get('/api/download', async (req, res) => {
  const { url, title, quality } = req.query;
  if (!url) {
    return res.status(400).send('Missing video URL');
  }

  try {
    const safeTitle = (title ? title.replace(/[^a-zA-Z0-9_\u0600-\u06FF\s-]/g, '').trim() : 'fbdowns') || 'fbdowns';
    const fileName = `${safeTitle}-${quality || 'HD'}.mp4`;

    const videoStream = await axios({
      method: 'GET',
      url: decodeURIComponent(url),
      responseType: 'stream',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
    });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Type', 'video/mp4');

    if (videoStream.headers['content-length']) {
      res.setHeader('Content-Length', videoStream.headers['content-length']);
    }

    videoStream.data.pipe(res);
  } catch (err) {
    console.error('Download stream error:', err.message);
    // If proxy stream fails, redirect directly to video CDN URL
    res.redirect(url);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'fbdowns.pro', timestamp: new Date().toISOString() });
});

// Catch-all to serve index.html for any frontend route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 FBDowns.pro server running on http://localhost:${PORT}`);
});
