import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3006;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json({ limit: '30mb' }));

// ─── Catalogue ────────────────────────────────────────────────────────────────
const CATALOGUE_PATH = path.join(__dirname, 'catalogue.json');

function loadCatalogue() {
  try {
    return JSON.parse(fs.readFileSync(CATALOGUE_PATH, 'utf-8'));
  } catch {
    return { collections: [] };
  }
}

app.get('/api/catalogue', (req, res) => {
  res.json(loadCatalogue());
});

app.post('/api/admin/catalogue', (req, res) => {
  const body = req.body;
  if (!body?.collections && !body?.products) {
    return res.status(400).json({ error: 'collections or products array required' });
  }
  fs.writeFileSync(CATALOGUE_PATH, JSON.stringify(body, null, 2));
  res.json({ ok: true });
});

// ─── Image helpers ─────────────────────────────────────────────────────────────
async function toBase64(url) {
  try {
    if (url.startsWith('data:')) {
      const [header, data] = url.split(',');
      const mimeType = header.replace('data:', '').replace(';base64', '');
      return { data, mimeType };
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const ct = res.headers.get('content-type')?.split(';')[0] || '';
    const mime = ct.startsWith('image/') ? ct : 'image/jpeg';
    return { data: Buffer.from(buf).toString('base64'), mimeType: mime };
  } catch (e) {
    console.error('[toBase64] failed:', url.slice(0, 80), e.message);
    return null;
  }
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

// Locations for variety — rotated by product index
const LOCATIONS = [
  { place: 'Heathrow Terminal 5, London', vibe: 'luxury airport departure lounge, floor-to-ceiling windows, golden morning light' },
  { place: 'The Louvre courtyard, Paris', vibe: 'iconic glass pyramid at dusk, warm golden hour light, European grandeur' },
  { place: 'JFK International Airport, New York', vibe: 'stylish terminal interior, city energy, natural skylight' },
  { place: 'Colosseum, Rome', vibe: 'ancient architecture backdrop, warm Italian sun, cobblestone path' },
  { place: 'The Shard viewpoint, London', vibe: 'rooftop terrace, panoramic city skyline at sunset, moody British light' },
  { place: 'Grand Central Terminal, New York', vibe: 'iconic golden hall, cathedral ceiling light beams, architectural splendor' },
  { place: 'Santorini cliffside, Greece', vibe: 'white-washed walls, Aegean sea view, sunset golden glow' },
  { place: 'O\'Hare International, Chicago', vibe: 'neon tunnel walkway, modern architecture, vibrant light' },
  { place: 'The Thames at dusk, London', vibe: 'river promenade, Tower Bridge in background, blue-hour city glow' },
  { place: 'Nice Côte d\'Azur Airport', vibe: 'Mediterranean light, palm trees visible, open-air departures' },
  { place: 'Grand Hotel Vienna entrance', vibe: 'imperial European hotel steps, marble columns, warm evening light' },
  { place: 'CDG Airport Paris, Terminal 2E', vibe: 'sweeping curved architecture, Parisian elegance, soft diffused light' },
];

function buildCollectionPrompt(productName, category, collectionName, locationIdx) {
  const loc = LOCATIONS[locationIdx % LOCATIONS.length];
  return `You are a world-class luxury travel lifestyle photographer and virtual product placement AI. You have two images:
- Image 1: A photo of a real person (the customer/traveler)
- Image 2: A product photo of a TravelPro "${productName}" from the ${collectionName} collection

SCENE: ${loc.place}
ATMOSPHERE: ${loc.vibe}

TASK: Generate one stunning photorealistic LUXURY TRAVEL LIFESTYLE image of this person naturally traveling with this exact TravelPro bag at this location. This should look like a premium editorial travel campaign — think Condé Nast Traveller, Vogue Travel, or a high-end luggage brand's global campaign.

PRODUCT PLACEMENT:
- The TravelPro bag is the CO-HERO of this image alongside the person
- It must be prominently featured — a key visual element, not an afterthought
- Show the exact colorway, TravelPro logo/branding, wheels, handles, and design details from Image 2 with crystal clarity
- Person is naturally rolling it, carrying it, or standing beside it in a way that feels authentic to the travel moment

COMPOSITION:
- 3/4 body shot OR full-length depending on the setting — choose what looks most cinematic
- Both person AND bag clearly and sharply in frame
- Use depth of field to isolate subject from background while keeping the iconic location recognizable
- Dynamic angle — slight low angle or eye-level with subject slightly off-center feels most editorial

LIGHTING:
- Cinematic, directional natural light fitting the scene (golden hour, diffused overcast, or dramatic interior shafts)
- Crisp specular highlight on the bag's surface to show its premium finish
- Natural shadows that add depth and realism

OUTFIT: The person wears elegant, elevated travel attire that complements the bag — sophisticated but not overdressed. Think business-casual luxe.

MOOD: Confident, aspirational, effortless. The kind of traveler who has been everywhere and wears it lightly.

STRICT PRESERVATION RULES:
1. Person's face — exact same features, expression, skin tone. Zero changes.
2. Person's hair — exact same style and color.
3. TravelPro bag — exact same color, design, logo, wheels, handles as Image 2. No changes to the product.
4. Photorealistic — must look like an actual photograph taken on location, not a composite.
5. NO watermarks, text overlays, brand name text, graphic additions, or artificial borders.

Output a single breathtaking editorial luxury travel photograph.`;
}

function buildHeroPrompt(productNames) {
  const bagList = productNames.join(', ');
  return `You are a world-class luxury fashion and travel photographer. You have multiple images:
- Image 1: A photo of a real person (the traveler)
- Images 2+: Product photos of multiple TravelPro luggage pieces: ${bagList}

SCENE: Grand Heathrow Terminal 5 departure hall — floor-to-ceiling glass walls, warm sunrise light flooding in, empty premium check-in desks in the background. The architecture is sweeping and modern.

TASK: Generate one stunning HERO lifestyle photograph of the person surrounded by or with multiple TravelPro bags arranged artfully around them. This is a full TravelPro travel set campaign shot — aspirational, premium, editorial.

COMPOSITION:
- Full-length or 3/4 shot, person centered or slightly off-center
- Multiple bags arranged naturally around the person — some standing upright, one being held/rolled
- Bags must all be clearly visible with their TravelPro branding showing
- Ultra-wide cinematic crop — the airport architecture frames the scene

LIGHTING: Golden sunrise streaming through floor-to-ceiling glass, casting long warm shadows. Premium interior lighting supplements.

PERSON: Wearing a sharp, elevated travel outfit — think first-class passenger energy. Confident stance, slight off-camera gaze, mid-arrival or pre-departure moment.

MOOD: The beginning of an extraordinary journey. Luxury. Freedom. Sophistication.

STRICT PRESERVATION RULES:
1. Person's face — exact same features, expression, skin tone. Zero changes.
2. Person's hair — exact same style and color.
3. All TravelPro bags — exact same colors, designs, logos as shown in product images.
4. Photorealistic — looks like a real high-budget campaign photograph.
5. NO watermarks, text, brand overlays, or graphic additions.

Output a single breathtaking hero travel campaign image.`;
}

function buildGridPrompt(productName, locationIdx) {
  const loc = LOCATIONS[(locationIdx + 4) % LOCATIONS.length]; // offset so grid gets different locations
  return `You are a luxury travel lifestyle photographer. You have two images:
- Image 1: A photo of a real person
- Image 2: A TravelPro "${productName}" luggage

SCENE: ${loc.place} — ${loc.vibe}

TASK: Generate a stunning editorial travel lifestyle photo of the person with this TravelPro bag. This is for a premium brand grid — cinematic, beautiful, location-hero shot.

FRAMING: Wider environmental shot — person is confidently in the scene with bag, but the LOCATION is also a visual hero. Think travel magazine cover energy.

LIGHTING: Perfect for the location — golden hour, blue hour, or dramatic natural light.
MOOD: Luxury travel. Effortless confidence. The world is their home.

STRICT PRESERVATION RULES:
1. Person's face — exact same features, skin tone. No changes.
2. Person's hair — exact same style and color.
3. TravelPro bag — exact same color and design as Image 2.
4. Photorealistic. No watermarks or text.

Output a single stunning editorial travel photo.`;
}

// ─── Generate card endpoint ───────────────────────────────────────────────────
// Body: { selfieDataUrl, productImageUrl, productName, category, collectionName, promptType, locationIdx }
// promptType: 'collection' | 'grid' | 'hero'
app.post('/api/generate-card', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const {
    selfieDataUrl,
    productImageUrl,
    productName = 'bag',
    category = 'Travel',
    collectionName = 'TravelPro',
    promptType = 'collection',
    locationIdx = 0,
    extraProductImageUrls = [], // for hero shot
  } = req.body;

  if (!selfieDataUrl || !productImageUrl) {
    return res.status(400).json({ error: 'selfieDataUrl and productImageUrl are required' });
  }

  const [selfie, product] = await Promise.all([toBase64(selfieDataUrl), toBase64(productImageUrl)]);
  if (!selfie || !product) {
    return res.status(422).json({ error: `Could not load ${!selfie ? 'selfie' : 'product'} image` });
  }

  // For hero: load extra product images too (up to 2 more)
  const extraProducts = [];
  if (promptType === 'hero' && extraProductImageUrls.length > 0) {
    const extras = await Promise.all(extraProductImageUrls.slice(0, 2).map(u => toBase64(u)));
    extraProducts.push(...extras.filter(Boolean));
  }

  let prompt;
  if (promptType === 'hero') {
    prompt = buildHeroPrompt([productName, ...(req.body.extraProductNames || [])]);
  } else if (promptType === 'grid') {
    prompt = buildGridPrompt(productName, locationIdx);
  } else {
    prompt = buildCollectionPrompt(productName, category, collectionName, locationIdx);
  }

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[gen-card] "${productName}" (${promptType}) attempt ${attempt}`);

      const parts = [
        { inline_data: { mime_type: selfie.mimeType, data: selfie.data } },
        { inline_data: { mime_type: product.mimeType, data: product.data } },
        ...extraProducts.map(p => ({ inline_data: { mime_type: p.mimeType, data: p.data } })),
        { text: prompt },
      ];

      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
          }),
          signal: AbortSignal.timeout(120000),
        }
      );

      if (!r.ok) {
        const errText = await r.text();
        console.error(`[gen-card] Gemini error attempt ${attempt}:`, r.status, errText.slice(0, 200));
        if (attempt < MAX_ATTEMPTS) continue;
        return res.status(502).json({ error: `Gemini error: ${r.status}` });
      }

      const data = await r.json();
      const responseParts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = responseParts.find(p => p.inlineData?.data);

      if (!imagePart?.inlineData) {
        const reason = data?.candidates?.[0]?.finishReason;
        console.error(`[gen-card] No image attempt ${attempt}, reason:`, reason);
        if (attempt < MAX_ATTEMPTS) continue;
        return res.status(502).json({ error: `No image generated (${reason || 'unknown'})` });
      }

      console.log(`[gen-card] "${productName}" done on attempt ${attempt}`);
      return res.json({ imageData: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType });
    } catch (e) {
      console.error(`[gen-card] error attempt ${attempt}:`, e.message);
      if (attempt < MAX_ATTEMPTS) continue;
      return res.status(500).json({ error: `Generation failed: ${e.message}` });
    }
  }

  res.status(500).json({ error: 'Failed after all attempts' });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`TravelPro backend running on port ${PORT}`));
