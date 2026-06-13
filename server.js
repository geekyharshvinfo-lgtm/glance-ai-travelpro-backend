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

// Riviera/Cannes scene + styling direction, keyed by collection theme.
// Each collection has a fixed primary scene plus a couple of scene variations
// (rotated by product index) so the 3 products in a collection don't look identical.
const RIVIERA_THEMES = {
  'cannes-riviera': {
    styling: 'crisp white linen shirt or blouse, beige tailored chinos or shorts, a lightweight blazer worn open, leather loafers or minimalist sneakers, designer sunglasses and a refined watch',
    scenes: [
      { place: 'La Croisette, Cannes', vibe: 'palm-lined boulevard along the French Riviera, grand Belle Époque hotel facades, warm late-afternoon Mediterranean sun' },
      { place: 'Boulevard de la Croisette promenade, Cannes', vibe: 'elegant seaside walkway, luxury boutiques, golden hour light off the bay' },
      { place: 'Carlton Cannes hotel steps', vibe: 'iconic white Riviera hotel entrance, manicured palms, soft glamorous evening light' },
    ],
  },
  'mediterranean-escape': {
    styling: 'a flowy summer dress or relaxed linen co-ord, or a linen shirt with rolled sleeves and relaxed shorts, sandals or espadrilles, a straw hat and sunglasses',
    scenes: [
      { place: 'a Mediterranean beach club terrace', vibe: 'turquoise sea backdrop, white parasols and rattan loungers, bright sun-drenched holiday light' },
      { place: 'a coastal seaside village, French Riviera', vibe: 'pastel buildings, cobbled lanes down to the water, relaxed vacation glow' },
      { place: 'a sunlit Mediterranean cliffside path', vibe: 'azure coastline below, wild coastal flowers, golden afternoon haze' },
    ],
  },
  'yacht-weekend': {
    styling: 'a navy polo or striped Breton tee, white linen trousers or tailored shorts, a lightweight knit draped over the shoulders, boat shoes or espadrilles, sunglasses',
    scenes: [
      { place: 'a luxury yacht marina, Cannes', vibe: 'rows of white super-yachts, glittering harbour water, sophisticated coastal light' },
      { place: 'the teak deck of a moored yacht', vibe: 'open sea horizon, polished chrome and sail rigging, breezy sunlit leisure' },
      { place: 'Port Pierre Canto marina, Cannes', vibe: 'upscale waterfront, gangways and gleaming hulls, warm Riviera golden hour' },
    ],
  },
  'weekend-getaway': {
    styling: 'smart denim and linen combinations or a casual shirt dress, polo and chinos, clean white sneakers, a crossbody or sling accessory',
    scenes: [
      { place: 'a Provençal vineyard terrace near the Riviera', vibe: 'rows of vines, rustic stone villa, dappled warm countryside light' },
      { place: 'a charming Riviera café terrace', vibe: 'wicker bistro chairs, cobbled village square, relaxed sunny morning' },
      { place: 'a scenic Côte d\'Azur coastal road lookout', vibe: 'classic convertible nearby, sea views and cypress trees, bright travel light' },
    ],
  },
  'business-traveller': {
    styling: 'a smart blazer over a polo or crisp Oxford shirt, tailored trousers, clean leather sneakers or loafers, professional yet lightweight layering',
    scenes: [
      { place: 'the Palais des Festivals conference entrance, Cannes', vibe: 'modern glass-and-steel convention architecture, red-carpet steps, polished daytime light' },
      { place: 'a sleek Riviera business hotel lobby', vibe: 'marble floors, floor-to-ceiling windows onto the bay, sophisticated interior light' },
      { place: 'a Cannes waterfront business district walkway', vibe: 'palms beside contemporary offices, sea glimpsed between buildings, crisp morning light' },
    ],
  },
};

const DEFAULT_THEME = {
  styling: 'elegant, elevated travel attire — sophisticated but not overdressed, business-casual luxe',
  scenes: [{ place: 'the French Riviera', vibe: 'Mediterranean coastline, warm golden light, effortless luxury' }],
};

function themeFor(collectionId) {
  return RIVIERA_THEMES[collectionId] || DEFAULT_THEME;
}

function buildCollectionPrompt(productName, category, collectionName, locationIdx, collectionId) {
  const theme = themeFor(collectionId);
  const loc = theme.scenes[locationIdx % theme.scenes.length];
  return `You are a world-class luxury fashion and travel photographer shooting a premium global campaign for TravelPro. You have two images:
- Image 1: The traveler (your subject — their face, features, and hair must be reproduced with 100% accuracy)
- Image 2: A TravelPro "${productName}" — the hero product of this shot

SCENE: ${loc.place}
ATMOSPHERE: ${loc.vibe}
TIME OF DAY: Bright daytime — golden morning light or warm afternoon sun. No dusk, no night, no dim interiors.

YOUR MISSION: Create a single, jaw-dropping editorial travel photograph that could run as a double-page spread in Condé Nast Traveller, Vogue Travel, or a TravelPro global campaign. This image must stop the scroll.

SUBJECT — FACE & IDENTITY (CRITICAL):
- Reproduce the person's face with absolute pixel-perfect accuracy: same bone structure, same eye shape and color, same nose, same lips, same skin tone and texture
- Same hair — identical style, length, color, and how it falls
- This is NOT a stylized version. This is the exact same person, photographed on location.
- Their expression: confident, relaxed, naturally in the moment — not posed stiffly

PRODUCT PLACEMENT:
- The TravelPro "${productName}" is the CO-HERO of this image — not a prop, not an afterthought
- Reproduce it exactly: same colorway, same logo placement, same wheel design, same handle, same texture
- Show it prominently — person is mid-stride rolling it, resting their hand on it casually, or standing alongside it with natural weight
- The bag should be sharp, lit beautifully, and clearly identifiable as the exact product from Image 2

POSE & ENERGY:
- Dynamic, natural, editorial — movement or a moment caught mid-action (mid-stride, looking ahead, glancing back over shoulder)
- Full-length or confident 3/4 shot — whichever is more cinematic for the scene
- Body language: effortlessly stylish, like someone who travels this well every time
- NOT a static passport photo stance — give it life

COMPOSITION:
- Subject slightly off-center — rule of thirds; the location breathes around them
- Shallow depth of field: subject + bag razor sharp, background beautifully blurred but still recognizable as ${loc.place}
- Slight low angle (shooting from hip height up) gives an aspirational, editorial feel
- Wide enough crop to feel like a travel campaign, tight enough that the face reads clearly

LIGHTING (DAYLIGHT ONLY):
- Bright, directional natural sunlight — Mediterranean clarity, not flat overcast
- Golden-hour warmth OR sharp midday Riviera sun with crisp shadows
- Beautiful specular highlight on the bag's surface showing off its premium finish
- Natural rim light or catch light on the person's face

OUTFIT: ${theme.styling} — tailored to the "${collectionName}" moment, complementing the bag color.

BACKGROUND: ${loc.vibe} — rich environmental detail that places this unmistakably at ${loc.place}. Architecture, landscaping, water, or sky visible and beautiful.

MOOD: Aspirational. Luxurious. The kind of traveler people notice when they walk in.

ABSOLUTE PRESERVATION RULES — NEVER VIOLATE:
1. FACE: Exact same person. Same features, same skin tone, zero alterations. Treat it as a face transplant that must be indistinguishable.
2. HAIR: Exact same style, color, and texture.
3. BAG: Exact same product — same color, logo, design details as shown in Image 2. No creative reinterpretation.
4. PHOTOREALISM: Must look like a real photograph taken on location with a high-end camera. Not CGI, not illustration, not composite.
5. NO TEXT, watermarks, brand overlays, or graphic elements anywhere in the image.

Output: One breathtaking, campaign-ready luxury travel photograph.`;
}

function buildHeroPrompt(productNames) {
  const bagList = productNames.join(', ');
  return `You are a world-class luxury travel photographer shooting the hero campaign image for TravelPro's French Riviera collection. You have multiple images:
- Image 1: The traveler — reproduce their face, features, and hair with 100% exact accuracy
- Images 2+: TravelPro luggage pieces: ${bagList}

SCENE: La Croisette, Cannes — the iconic palm-lined seaside boulevard, grand Belle Époque hotel facades (Carlton or Martinez), the brilliant Mediterranean bay sparkling in the background. Unmistakably South of France.

TIME OF DAY: Bright mid-morning or early afternoon — crisp Mediterranean sunlight, deep blue sky, long sharp shadows. Pure daylight. No golden hour haze, no dusk, absolutely no night.

TASK: Create the definitive TravelPro Riviera hero shot — a full-spread campaign image of this exact person with the TravelPro luggage set arranged naturally around them on La Croisette.

SUBJECT — FACE & IDENTITY (CRITICAL):
- Reproduce this person's face with 100% accuracy: exact bone structure, eye shape, eye color, nose, lips, skin tone, skin texture
- Exact same hair — identical style, color, length, how it falls
- They are a real person being photographed in Cannes. Not illustrated. Not stylized. Identical.
- Expression: confident arrival, slight natural smile or composed gaze — owning the moment

COMPOSITION:
- Full-length shot — the person commanding the frame, bags arranged naturally at their sides and behind
- One bag being casually rolled or held; others standing elegantly around them
- Cinematic ultra-wide crop: La Croisette boulevard, palm trees, hotel facade, and the Mediterranean blue all visible
- Person slightly off-center, rule of thirds; the iconic Cannes backdrop breathes around them
- Shoot from slightly below eye level — gives an aspirational, editorial magazine-cover energy

OUTFIT: Crisp white linen shirt, perfectly tailored beige or stone trousers, lightweight blazer worn open, leather loafers, oversized designer sunglasses, a fine watch. Sharp, effortless, Riviera-ready.

BAGS: All TravelPro pieces must be clearly visible, sharp, and faithfully reproduced with their exact colors, logos, and design details from the product images. They are co-heroes of this image.

LIGHTING: Brilliant Mediterranean daylight — sharp specular highlights on the polished bag surfaces, clean shadows on the pavement, catchlights in the subject's eyes.

MOOD: An extraordinary arrival. The kind of traveler La Croisette was made for.

ABSOLUTE PRESERVATION RULES:
1. FACE: Zero alteration. Same person, identical features.
2. HAIR: Identical.
3. ALL BAGS: Exact colors, logos, and designs as product images.
4. PHOTOREALISM: Real photograph quality — high-end camera, shot on location.
5. NO text, watermarks, or graphic additions.

Output: One iconic, campaign-defining hero travel photograph.`;
}

function buildGridPrompt(productName, locationIdx, collectionId) {
  const theme = themeFor(collectionId);
  const loc = theme.scenes[(locationIdx + 1) % theme.scenes.length];
  return `You are a world-class luxury travel photographer shooting a location-hero campaign image for TravelPro. You have two images:
- Image 1: The traveler — their face and hair must be reproduced with 100% exact accuracy
- Image 2: A TravelPro "${productName}" — the featured product

SCENE: ${loc.place} — ${loc.vibe}
TIME OF DAY: Bright daytime — sharp Mediterranean sunlight, rich colours, deep blue sky. No evening, no dusk, no night whatsoever.

TASK: Create a stunning wide editorial travel photograph where both the person AND the location are heroes. Think travel magazine cover meets luxury brand campaign.

SUBJECT — FACE & IDENTITY (CRITICAL):
- Reproduce this person's face with complete accuracy: same features, same eye shape and colour, same nose and lips, same skin tone
- Exact same hair — same style, colour, and texture
- Same person. No stylization. Identical.
- Pose: natural, mid-movement — confident stride, hand on bag, looking ahead or glancing toward camera with ease

PRODUCT:
- The TravelPro "${productName}" is prominently featured — same exact color, logo, design details as Image 2
- Person is naturally rolling it, carrying it, or standing beside it
- Bag is sharp, well-lit, and clearly identifiable

COMPOSITION — WIDER ENVIRONMENTAL SHOT:
- Full-length or near-full-length — the person is in their element, the location surrounds them
- ${loc.place} clearly visible and beautiful — architecture, landscape, sky, or water as the backdrop
- Slight low angle for editorial lift; subject roughly centered or rule-of-thirds
- Depth of field: subject + bag sharp, background richly blurred but location still readable

LIGHTING: Brilliant natural daylight — crisp specular on the bag, clean catchlights in the eyes, warm directional Mediterranean sun.

OUTFIT: ${theme.styling}

MOOD: Confident, effortless, aspirational. Someone who travels like this every time.

ABSOLUTE PRESERVATION RULES:
1. FACE: Identical to Image 1 — zero changes, zero stylization.
2. HAIR: Identical style and color.
3. BAG: Exact same product — same color and design as Image 2.
4. PHOTOREALISM: Real photograph. Not CGI or illustration.
5. NO text, watermarks, or overlays.

Output: One stunning, wide editorial travel photograph.`;
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
    collectionId = '',
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
    prompt = buildGridPrompt(productName, locationIdx, collectionId);
  } else {
    prompt = buildCollectionPrompt(productName, category, collectionName, locationIdx, collectionId);
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
