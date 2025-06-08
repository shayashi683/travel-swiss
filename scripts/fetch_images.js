import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, '..');
const markdownPath = path.join(rootDir, 'project.md');
const imagesDir = path.join(rootDir, 'images');

/**
 * Simple helper to normalise spot name into a safe filename.
 */
function toFilename(spot) {
  return spot
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, '_') // spaces & nbsp to underscore
    .replace(/[^a-z0-9_\-]/g, '') // drop anything non url-safe
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') + '.jpg';
}

async function extractSpots(markdown) {
  const spotSet = new Set();
  const lines = markdown.split(/\n/);
  let inHighlight = false;
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (line.startsWith('### Day')) {
      inHighlight = true;
      continue;
    }
    if (inHighlight && line.startsWith('### ')) {
      inHighlight = false; // reached next section
    }
    if (!inHighlight) continue;

    if (line.startsWith('- ')) {
      const match = line.match(/^-\s+(.+?)(?:（|\(|$)/);
      if (match) {
        const spot = match[1].trim();
        // Skip if spot contains URL or colon (likely not a proper name)
        if (/https?:\/\//.test(spot) || /:/.test(spot)) continue;
        // skip long sentences (>5 words)
        if (spot.split(/\s+/).length > 5) continue;
        spotSet.add(spot);
      }
    }
  }
  return Array.from(spotSet);
}

async function ensureImagesDir() {
  try {
    await fs.mkdir(imagesDir, { recursive: true });
  } catch (err) {
    // ignore if exists
  }
}

async function downloadImage(page, spot, filename) {
  // Try Unsplash Source API first for quick direct image.
  const sourceUrl = `https://source.unsplash.com/1600x900/?${encodeURIComponent(spot)}`;
  try {
    const res = await fetch(sourceUrl);
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      await fs.writeFile(path.join(imagesDir, filename), Buffer.from(buffer));
      console.log(`Downloaded (source.unsplash.com) for ${spot}`);
      return true;
    }
  } catch (e) {
    console.warn(`Unsplash Source failed for ${spot}:`, e);
  }

  // Fallback to scraping the Unsplash search page via Playwright.
  const url = `https://unsplash.com/s/photos/${encodeURIComponent(spot)}`;
  console.log(`Fallback Playwright fetch for ${spot}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('figure img', { timeout: 30000 });
    const src = await page.$eval('figure img', img => img.getAttribute('src') || img.src);
    if (!src) {
      console.warn(`Could not extract image src for ${spot}`);
      return false;
    }
    const res = await fetch(src);
    if (!res.ok) {
      console.error(`Fetch failed for ${spot}: ${res.status}`);
      return false;
    }
    const buffer = await res.arrayBuffer();
    await fs.writeFile(path.join(imagesDir, filename), Buffer.from(buffer));
    return true;
  } catch (err) {
    console.error(`Playwright fetch failed for ${spot}:`, err);
    return false;
  }
}

async function updateMarkdown(markdown, mapping) {
  const lines = markdown.split(/\n/);
  const updatedLines = lines.map(line => {
    if (!line.startsWith('- ')) return line;
    const spotMatch = line.match(/^\s*-\s+(.+?)(?:（|\(|$)/);
    if (!spotMatch) return line;
    const spot = spotMatch[1].trim();
    const filename = mapping[spot];
    if (!filename) return line;
    if (line.includes('![')) return line; // already has image
    const imageMarkdown = ` ![${spot}](images/${filename})`;
    return line + imageMarkdown;
  });
  return updatedLines.join('\n');
}

(async () => {
  const markdown = await fs.readFile(markdownPath, 'utf-8');
  const spots = await extractSpots(markdown);

  await ensureImagesDir();

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const mapping = {};
  for (const spot of spots) {
    const filename = toFilename(spot);
    mapping[spot] = filename;
    const filePath = path.join(imagesDir, filename);
    try {
      await fs.access(filePath);
      console.log(`Image already exists for ${spot}, skipping download.`);
    } catch {
      await downloadImage(page, spot, filename);
    }
  }

  await browser.close();

  const newMarkdown = await updateMarkdown(markdown, mapping);
  if (newMarkdown !== markdown) {
    await fs.writeFile(markdownPath, newMarkdown, 'utf-8');
    console.log('project.md updated with image links.');
  } else {
    console.log('No changes to project.md');
  }
})(); 