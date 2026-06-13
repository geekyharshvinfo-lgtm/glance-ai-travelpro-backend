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
    male: 'a crisp white or pale-blue short-sleeve linen shirt (or a fine cotton polo), perfectly tailored stone, beige or white lightweight linen trousers or smart tailored shorts, woven leather loafers or premium minimalist white sneakers, oversized designer sunglasses and a slim luxury watch — light, airy hot-summer fabrics, masculine and effortlessly sharp, absolutely NO jacket, blazer, or knitwear',
    female: 'an elegant flowing summer midi dress in white or a soft pastel, OR a breezy linen blouse with high-waisted tailored linen trousers or a flowing skirt, strappy leather sandals or chic espadrilles, oversized designer sunglasses and refined gold jewellery — light, airy hot-summer fabrics, feminine and graceful, absolutely NO jacket, blazer, or knitwear',
    scenes: [
      { place: 'La Croisette, Cannes', vibe: 'palm-lined boulevard along the French Riviera, grand Belle Époque hotel facades, warm late-afternoon Mediterranean sun' },
      { place: 'Boulevard de la Croisette promenade, Cannes', vibe: 'elegant seaside walkway, luxury boutiques, golden hour light off the bay' },
      { place: 'Carlton Cannes hotel steps', vibe: 'iconic white Riviera hotel entrance, manicured palms, soft glamorous evening light' },
    ],
  },
  'mediterranean-escape': {
    male: 'an open short-sleeve linen shirt over a fine tank or worn buttoned, relaxed linen drawstring trousers or tailored summer shorts, leather sandals or espadrilles, a woven straw fedora and sunglasses — breathable hot-weather resort wear, relaxed masculine vacation ease, NO jacket, blazer, or knitwear',
    female: 'a flowy lightweight sundress or a relaxed linen co-ord set in warm neutral or pastel tones, strappy flat sandals or espadrilles, a wide-brim straw sun hat and oversized sunglasses, delicate jewellery — breathable hot-weather resort wear, feminine and sun-kissed, NO jacket, blazer, or knitwear',
    scenes: [
      { place: 'a Mediterranean beach club terrace', vibe: 'turquoise sea backdrop, white parasols and rattan loungers, bright sun-drenched holiday light' },
      { place: 'a coastal seaside village, French Riviera', vibe: 'pastel buildings, cobbled lanes down to the water, relaxed vacation glow' },
      { place: 'a sunlit Mediterranean cliffside path', vibe: 'azure coastline below, wild coastal flowers, golden afternoon haze' },
    ],
  },
  'yacht-weekend': {
    male: 'a short-sleeve navy polo or striped Breton tee, white linen trousers or tailored shorts, brown leather boat shoes or espadrilles, aviator sunglasses — crisp hot-summer nautical look, NO jacket, blazer, or knitwear',
    female: 'a striped Breton top or a white off-shoulder linen blouse with white wide-leg trousers or a nautical skirt, espadrilles or strappy flats, gold hoops and oversized sunglasses — chic hot-summer nautical look, NO jacket, blazer, or knitwear',
    // Distinct outfit per product (rotated by product index) so the 3 cards in this
    // collection don't look like the same look in different colours. Each entry is
    // gendered so men and women get appropriately different garments.
    maleOutfits: [
      'a crisp white short-sleeve linen shirt left casually open over a fitted tank, tailored beige linen shorts, leather espadrilles and tortoiseshell sunglasses — relaxed hot-summer yacht style, NO jacket/blazer/knitwear',
      'a navy-and-white striped Breton tee tucked into white tailored trousers, brown leather boat shoes, a woven belt and aviator sunglasses — classic nautical hot-summer look, NO jacket/blazer/knitwear',
      'a soft pastel (sky-blue or coral) short-sleeve polo with stone-coloured chino shorts, white minimalist sneakers and a fine watch — bright breezy hot-summer marina style, NO jacket/blazer/knitwear',
    ],
    femaleOutfits: [
      'a white off-shoulder linen blouse with high-waisted wide-leg cream trousers, strappy leather flats and tortoiseshell sunglasses — relaxed elegant hot-summer yacht style, NO jacket/blazer/knitwear',
      'a navy-and-white striped Breton top tucked into white tailored shorts, espadrilles, a woven belt and aviator sunglasses — classic nautical hot-summer look, NO jacket/blazer/knitwear',
      'a soft pastel (sky-blue or coral) sleeveless linen sundress with flat sandals and delicate gold jewellery — bright breezy hot-summer marina style, NO jacket/blazer/knitwear',
    ],
    scenes: [
      { place: 'a luxury yacht marina, Cannes', vibe: 'rows of white super-yachts, glittering harbour water, sophisticated coastal light' },
      { place: 'the teak deck of a moored yacht', vibe: 'open sea horizon, polished chrome and sail rigging, breezy sunlit leisure' },
      { place: 'Port Pierre Canto marina, Cannes', vibe: 'upscale waterfront, gangways and gleaming hulls, warm Riviera golden hour' },
    ],
  },
  'weekend-getaway': {
    male: 'a light short-sleeve shirt or a fine polo with lightweight chinos or tailored shorts, clean white leather sneakers, a slim crossbody or sling accessory and sunglasses — easy hot-weather travel wear, relaxed and masculine, NO jacket, blazer, or knitwear',
    female: 'a casual short-sleeve summer shirt-dress or a light blouse with relaxed linen trousers or a flowy skirt, clean white sneakers or flat sandals, a crossbody bag and sunglasses — easy hot-weather travel wear, relaxed and feminine, NO jacket, blazer, or knitwear',
    scenes: [
      { place: 'a Provençal vineyard terrace near the Riviera', vibe: 'rows of vines, rustic stone villa, dappled warm countryside light' },
      { place: 'a charming Riviera café terrace', vibe: 'wicker bistro chairs, cobbled village square, relaxed sunny morning' },
      { place: 'a scenic Côte d\'Azur coastal road lookout', vibe: 'classic convertible nearby, sea views and cypress trees, bright travel light' },
    ],
  },
  'business-traveller': {
    male: 'smart summer-weight business attire — a crisp short-sleeve or rolled-sleeve Oxford shirt with sharply tailored trousers, OR an unstructured lightweight linen blazer worn open over a fine shirt (breathable hot-weather formal only, never heavy wool), a slim leather belt, polished leather loafers or refined minimalist sneakers — masculine, polished but cool for a Riviera heatwave',
    female: 'smart summer-weight business attire — a tailored sleeveless or short-sleeve blouse with high-waisted tailored trousers or a pencil skirt, OR an unstructured lightweight linen blazer worn open over a fine top (breathable hot-weather formal only, never heavy wool), elegant low heels or refined flats, minimal gold jewellery — feminine, polished but cool for a Riviera heatwave',
    scenes: [
      { place: 'the Palais des Festivals conference entrance, Cannes', vibe: 'modern glass-and-steel convention architecture, red-carpet steps, polished daytime light' },
      { place: 'a sleek Riviera business hotel lobby', vibe: 'marble floors, floor-to-ceiling windows onto the bay, sophisticated interior light' },
      { place: 'a Cannes waterfront business district walkway', vibe: 'palms beside contemporary offices, sea glimpsed between buildings, crisp morning light' },
    ],
  },
};

const DEFAULT_THEME = {
  male: 'elegant, elevated summer travel attire for a man — a light linen shirt with tailored trousers, refined and sophisticated but not overdressed, business-casual luxe, NO heavy jacket or knitwear',
  female: 'elegant, elevated summer travel attire for a woman — a light blouse or summer dress with refined accessories, sophisticated but not overdressed, business-casual luxe, NO heavy jacket or knitwear',
  scenes: [{ place: 'the French Riviera', vibe: 'Mediterranean coastline, warm golden light, effortless luxury' }],
};

function themeFor(collectionId) {
  return RIVIERA_THEMES[collectionId] || DEFAULT_THEME;
}

// Returns the gendered wardrobe pair for a collection. When the theme defines
// per-product outfit variants (e.g. yacht-weekend), the product index selects a
// distinct look so the cards in one collection don't repeat the same garment.
function wardrobeFor(theme, productIdx = 0) {
  if (theme.maleOutfits && theme.femaleOutfits) {
    const i = productIdx % theme.maleOutfits.length;
    return { male: theme.maleOutfits[i], female: theme.femaleOutfits[i % theme.femaleOutfits.length] };
  }
  return { male: theme.male, female: theme.female };
}

// ─── Shared strict instruction blocks ──────────────────────────────────────────
// Reused verbatim across all three prompt builders so every generated image is held
// to the same professional standard for identity, anatomy, and gendered wardrobe.

const FACE_IDENTITY_BLOCK = `SUBJECT — FACE & IDENTITY (THE #1 NON-NEGOTIABLE REQUIREMENT — DO NOT FAIL THIS):
- The face in the OUTPUT must be the EXACT SAME FACE as the real person in Image 1 — not similar, not "inspired by", not an idealized version, but IDENTICAL, as if their real face were photographed directly on location. A viewer who knows this person must instantly recognize them.
- Reproduce with forensic, pixel-level accuracy EVERY identifying feature: the exact head and skull shape, exact face shape and width, exact jawline and chin, exact cheekbones, exact forehead, exact eye shape, exact eye spacing, exact eye colour, exact eyelids, exact eyebrows (shape, thickness, colour), exact nose (bridge, width, tip, nostrils), exact lips (shape, fullness, colour), exact ears, exact skin tone and undertone, exact skin texture, pores, any freckles, moles, scars, wrinkles, or blemishes, and the exact apparent age.
- Reproduce facial hair EXACTLY if present (beard, stubble, moustache shape, density, colour) and do not add facial hair if absent.
- Reproduce hair EXACTLY: same style, same length, same colour and highlights, same parting, same hairline, same texture (straight/wavy/curly), and the same way it falls.
- ABSOLUTELY DO NOT beautify, slim, smooth, airbrush, lighten or darken, de-age, age, change ethnicity, enlarge eyes, sharpen the jaw, or make the person more conventionally attractive in ANY way. Imperfections are part of their identity — keep them all.
- This is a real photograph of THIS exact person, NOT a stylized, generated, or "lookalike" face. Treat it as a flawless face transplant that must be indistinguishable from Image 1.
- If any trade-off is ever required, PRESERVE FACE IDENTITY ABOVE EVERYTHING ELSE — pose, lighting, framing, and composition may flex; the face and identity may NOT.`;

const BODY_ANATOMY_BLOCK = `FULL-BODY ANATOMY & POSE (CRITICAL — THE MOST COMMON FAILURE, GET THIS PERFECT):
- Render a complete, FULL-LENGTH, head-to-toe human that is ONE single, anatomically flawless, naturally proportioned person. A broken, split, or warped lower body is the most common and most unacceptable failure — you MUST get the entire body anatomically correct.
- The head, neck, shoulders, torso, waist, hips, both legs, and both feet form ONE continuous, seamlessly connected body. The hips sit directly beneath the torso; the spine is straight and natural; the legs descend naturally from the hips; knees and ankles bend correctly and realistically.
- The ENTIRE body — head through feet — must face and move in ONE single, consistent direction. Do NOT let the upper body face one way and the lower body another. No twisting, severing, splitting, mirroring, duplicating, detaching, elongating, or offsetting of the torso, hips, or legs.
- BOTH legs and BOTH feet must be clearly visible, correctly shaped, and planted naturally and believably on the ground in a balanced mid-stride or standing pose. No floating, no feet melting into the ground, no missing, extra, or duplicated legs or feet, no impossible joints.
- Correct, realistic human proportions head-to-toe: leg length proportional to the torso, natural shoulder width, exactly two arms and two legs, and natural hands with exactly five fingers each. No extra, missing, fused, bent-backwards, or warped limbs or digits.
- The pose is relaxed, balanced, and physically plausible — the weight distribution is believable and the centre of gravity is correct. The final result must read as a genuine photograph of one whole, coherent person, legs and stride included — never a stitched-together, AI-melted, or distorted figure.`;

function wardrobeBlock(wardrobe) {
  return `WARDROBE — FIRST detect the subject's apparent gender and body type from Image 1, THEN dress them in the matching outfit below (and ONLY that one). The clothing must fit their real body naturally and realistically:
- IF THE SUBJECT IS MALE / MASCULINE-PRESENTING: ${wardrobe.male}
- IF THE SUBJECT IS FEMALE / FEMININE-PRESENTING: ${wardrobe.female}
Choose exactly one based on the real person in Image 1. The garments must drape and fit like real fabric on a real body — correct sizing, natural folds and seams, no melted, fused, see-through, or impossible clothing. Keep it tasteful, elegant, and weather-appropriate.`;
}

function buildCollectionPrompt(productName, category, collectionName, locationIdx, collectionId) {
  const theme = themeFor(collectionId);
  const loc = theme.scenes[locationIdx % theme.scenes.length];
  // Distinct, gendered outfit per product so the 3 cards in a collection vary in
  // actual garments — not just colour — and match the subject's real gender.
  const wardrobe = wardrobeFor(theme, locationIdx);
  return `ROLE: You are a world-class luxury fashion and travel photographer shooting a premium global advertising campaign for TravelPro, the heritage luggage house. Your work runs as double-page spreads in Condé Nast Traveller, Vogue Travel, and Harper's Bazaar. You are a master of identity-accurate portraiture, anatomy, natural light, and product fidelity.

YOU ARE GIVEN TWO REFERENCE IMAGES:
- Image 1: The TRAVELER — your real human subject. Their face, identity, hair, and apparent gender MUST be reproduced with 100% accuracy.
- Image 2: A TravelPro "${productName}" — the hero product, which MUST be reproduced exactly.

ASSIGNMENT: Produce ONE single, jaw-dropping, hyper-realistic editorial travel photograph of the EXACT person from Image 1, on location, styled for the "${collectionName}" moment, with the TravelPro "${productName}" as co-hero. It must look like a genuine high-end campaign photograph that stops the scroll — not an AI render.

SCENE: ${loc.place}
ATMOSPHERE: ${loc.vibe}
TIME OF DAY: Bright daytime — golden morning light or warm afternoon Mediterranean sun. No dusk, no night, no dim interiors.
WEATHER: A HOT Cannes summer heatwave — the subject wears light, breathable warm-weather clothing only. No jackets, no blazers, no coats, no knitwear, no scarves — only airy summer fabrics.

${FACE_IDENTITY_BLOCK}
- Their expression here: confident, relaxed, and naturally in the moment — but the underlying face and identity stay 100% theirs.

${BODY_ANATOMY_BLOCK}

${wardrobeBlock(wardrobe)}
- This specific look must be visibly DIFFERENT from the other looks in this same collection — different garments and silhouette, not the same outfit recoloured. It should complement the bag's colour and suit the "${collectionName}" moment.

PRODUCT FIDELITY — THE BAG IS CO-HERO (NOT A PROP):
- Reproduce the TravelPro "${productName}" from Image 2 EXACTLY: same colourway, same material and texture, same logo placement, same zips, same handle and telescopic handle, same wheel design, same proportions. No creative reinterpretation, no invented details.
- Feature it prominently and naturally — the person is mid-stride rolling it, resting a hand on it, or standing alongside it with believable weight and contact (hand actually grips the handle; bag actually rests on the ground).
- The bag is sharp, beautifully lit, and instantly identifiable as the exact product from Image 2.

POSE & ENERGY:
- Dynamic, natural, editorial — a moment caught mid-action (mid-stride, looking ahead, glancing back over the shoulder). Effortlessly stylish, like a seasoned luxury traveler. NOT a stiff, static passport stance.

COMPOSITION:
- Full-length figure, subject slightly off-centre on the rule of thirds; the location breathes around them.
- Shallow depth of field: subject and bag razor-sharp, background beautifully blurred yet clearly recognizable as ${loc.place}.
- A slight low angle (shooting from hip height upward) for an aspirational, editorial lift. Wide enough to feel like a travel campaign, with the face still reading clearly.

LIGHTING (DAYLIGHT ONLY):
- Bright, directional natural sunlight with Mediterranean clarity — golden-hour warmth or crisp midday Riviera sun with clean shadows.
- A beautiful specular highlight along the bag's surface showing its premium finish, and a natural catchlight in the subject's eyes.

MOOD: Aspirational, luxurious, alive. The kind of traveler people notice when they walk in.

RENDER QUALITY: Ultra-high fidelity, photographic realism, shot as if on a full-frame camera with a fast prime lens. Rich colour depth, true-to-life skin, crisp focus on subject and bag, natural film-like tonality. Take the time needed to get identity, anatomy, and product exactly right.

ABSOLUTE PRESERVATION RULES — NEVER VIOLATE:
1. FACE & IDENTITY: The exact same person as Image 1 — same features, skin tone, marks, and age. Indistinguishable. Zero beautification or alteration.
2. HAIR & FACIAL HAIR: Exactly as in Image 1 — style, length, colour, texture.
3. GENDER & WARDROBE: Dress the subject according to their real gender from Image 1, using the matching outfit above. Garments fit and drape like real fabric.
4. BODY: One whole, coherent, anatomically correct full-length person — upper and lower body aligned, connected, naturally proportioned. No split, duplicated, floating, or warped anatomy.
5. BAG: The exact product from Image 2 — same colour, logo, and design.
6. PHOTOREALISM: A real photograph from a high-end camera. Not CGI, illustration, or composite.
7. NO text, watermarks, brand overlays, captions, or graphic elements anywhere in the image.

OUTPUT: One breathtaking, campaign-ready luxury travel photograph of the exact person from Image 1.`;
}

function buildHeroPrompt(productNames) {
  const bagList = productNames.join(', ');
  const heroWardrobe = {
    male: 'a crisp white short-sleeve linen shirt or airy fine-cotton summer shirt, perfectly tailored stone or beige lightweight linen trousers (or smart tailored shorts), woven leather loafers or premium minimalist sneakers, oversized designer sunglasses and a fine watch — sharp, effortless, masculine, cool for the heat. NO jacket, blazer, coat, or knitwear.',
    female: 'an elegant flowing white or pastel summer dress, OR an airy linen blouse with high-waisted tailored linen trousers, strappy leather sandals or chic espadrilles, oversized designer sunglasses and refined gold jewellery — graceful, effortless, feminine, cool for the heat. NO jacket, blazer, coat, or knitwear.',
  };
  return `ROLE: You are a world-class luxury travel photographer shooting THE hero campaign image — the single opening image of TravelPro's French Riviera store. This is the most important, most beautiful image of the entire campaign. You are a master of identity-accurate portraiture, anatomy, natural light, and product fidelity.

YOU ARE GIVEN MULTIPLE REFERENCE IMAGES:
- Image 1: The TRAVELER — your real human subject. Reproduce their face, identity, hair, and apparent gender with 100% exact accuracy.
- Images 2+: TravelPro luggage pieces to feature: ${bagList}.

ASSIGNMENT: Create the single most beautiful, ultra-high-quality TravelPro Riviera hero photograph imaginable — a full-spread luxury campaign image of the EXACT person from Image 1, visibly happy and joyfully enjoying their dream Riviera vacation, with TravelPro luggage beside them on La Croisette. Breathtaking, premium, aspirational at the highest level, and unmistakably a real photograph.

SCENE: La Croisette, Cannes — the iconic palm-lined seaside boulevard, grand Belle Époque hotel facades (Carlton or Martinez), the brilliant Mediterranean bay sparkling behind. Unmistakably the South of France.
TIME OF DAY: Bright mid-morning or early afternoon — crisp Mediterranean sunlight, deep blue sky, clean sharp shadows. Pure daylight, no dusk, absolutely no night.
WEATHER: A HOT, glorious Cannes summer heatwave — the subject wears light, breathable warm-weather summer clothing only. No jackets, no blazers, no coats, no knitwear.

${FACE_IDENTITY_BLOCK}
- Their expression here: genuinely happy and radiant — a warm, natural smile, relaxed and clearly enjoying a wonderful summer vacation — while the underlying face and identity stay 100% theirs.

${BODY_ANATOMY_BLOCK}

${wardrobeBlock(heroWardrobe)}

COMPOSITION:
- Full-length figure commanding the frame, with the luggage arranged naturally at their sides and slightly behind. One bag is casually rolled or held; the others stand elegantly around them.
- Cinematic ultra-wide crop: La Croisette boulevard, palm trees, hotel facade, and the Mediterranean blue all visible. Person slightly off-centre on the rule of thirds; the iconic Cannes backdrop breathes around them.
- Shoot from slightly below eye level for aspirational, magazine-cover energy.

PRODUCT FIDELITY: The TravelPro luggage must be clearly visible, sharp, and faithfully reproduced with the EXACT colours, logos, materials, handles, wheels, and design details from the product images — true co-heroes of the image, positioned beautifully beside the subject, with believable contact and weight.

LIGHTING: Brilliant Mediterranean daylight — sharp specular highlights on the polished bag surfaces, clean shadows on the pavement, catchlights in the subject's eyes.

MOOD: Pure joy and luxury — a person living their best summer vacation on the French Riviera. Warm, happy, aspirational, unforgettable.

RENDER QUALITY: The highest possible fidelity — photographic realism as if shot on a full-frame camera with a premium prime lens. Crisp focus, rich colour depth, true-to-life skin, flawless natural tonality. Take the time needed to get identity, anatomy, and product exactly right.

ABSOLUTE PRESERVATION RULES — NEVER VIOLATE:
1. FACE & IDENTITY: The exact same person as Image 1 — indistinguishable, zero alteration or beautification.
2. HAIR & FACIAL HAIR: Exactly as in Image 1.
3. GENDER & WARDROBE: Dress according to the subject's real gender from Image 1, using the matching outfit above.
4. BODY: One whole, coherent, anatomically correct full-length person — aligned, connected, naturally proportioned. No split, duplicated, floating, or warped anatomy.
5. ALL BAGS: Exact colours, logos, and designs as the product images.
6. PHOTOREALISM: A real photograph from a high-end camera, shot on location. Not CGI, illustration, or composite.
7. NO text, watermarks, captions, or graphic additions.

OUTPUT: One iconic, campaign-defining hero travel photograph of the exact person from Image 1.`;
}

function buildGridPrompt(productName, locationIdx, collectionId) {
  const theme = themeFor(collectionId);
  const loc = theme.scenes[(locationIdx + 1) % theme.scenes.length];
  const wardrobe = wardrobeFor(theme, locationIdx + 1);
  return `ROLE: You are a world-class luxury travel photographer shooting a location-hero campaign image for TravelPro, the heritage luggage house. Your work runs in premium travel and fashion magazines. You are a master of identity-accurate portraiture, anatomy, natural light, and product fidelity.

YOU ARE GIVEN TWO REFERENCE IMAGES:
- Image 1: The TRAVELER — your real human subject. Reproduce their face, identity, hair, and apparent gender with 100% exact accuracy.
- Image 2: A TravelPro "${productName}" — the featured product, reproduced exactly.

ASSIGNMENT: Create a stunning wide editorial travel photograph of the EXACT person from Image 1 where both the person AND the location are heroes — travel-magazine cover meets luxury brand campaign — featuring the TravelPro "${productName}". It must look like a genuine high-end photograph.

SCENE: ${loc.place} — ${loc.vibe}
TIME OF DAY: Bright daytime — sharp Mediterranean sunlight, rich colours, deep blue sky. No evening, no dusk, no night whatsoever.
WEATHER: A HOT Cannes summer heatwave — the subject wears light, breathable warm-weather clothing only. No jackets, no blazers, no coats, no knitwear, no scarves.

${FACE_IDENTITY_BLOCK}
- Their expression here: natural and at ease — a confident stride, hand on the bag, looking ahead or glancing toward camera — while the underlying face and identity stay 100% theirs.

${BODY_ANATOMY_BLOCK}

${wardrobeBlock(wardrobe)}

PRODUCT FIDELITY:
- The TravelPro "${productName}" is prominently featured and reproduced EXACTLY from Image 2 — same colour, material, logo, zips, handle, wheels, and design details. No reinterpretation.
- The person naturally rolls it, carries it, or stands beside it with believable contact and weight. The bag is sharp, well-lit, and clearly identifiable.

COMPOSITION — WIDER ENVIRONMENTAL SHOT:
- Full-length figure, the person in their element with the location surrounding them.
- ${loc.place} clearly visible and beautiful — architecture, landscape, sky, or water as the backdrop.
- Slight low angle for editorial lift; subject roughly centred or on the rule of thirds.
- Depth of field: subject and bag sharp, background richly blurred but the location still readable.

LIGHTING: Brilliant natural daylight — crisp specular on the bag, clean catchlights in the eyes, warm directional Mediterranean sun.

MOOD: Confident, effortless, aspirational — someone who travels like this every time.

RENDER QUALITY: Ultra-high fidelity, photographic realism as if shot on a full-frame camera with a fast prime lens. Crisp focus on subject and bag, rich colour depth, true-to-life skin and natural tonality. Take the time needed to get identity, anatomy, and product exactly right.

ABSOLUTE PRESERVATION RULES — NEVER VIOLATE:
1. FACE & IDENTITY: The exact same person as Image 1 — indistinguishable, zero alteration or beautification.
2. HAIR & FACIAL HAIR: Exactly as in Image 1.
3. GENDER & WARDROBE: Dress according to the subject's real gender from Image 1, using the matching outfit above.
4. BODY: One whole, coherent, anatomically correct full-length person — aligned, connected, naturally proportioned. No split, duplicated, floating, or warped anatomy.
5. BAG: The exact product from Image 2 — same colour and design.
6. PHOTOREALISM: A real photograph from a high-end camera. Not CGI or illustration.
7. NO text, watermarks, or overlays.

OUTPUT: One stunning, wide editorial travel photograph of the exact person from Image 1.`;
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${GEMINI_API_KEY}`,
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
