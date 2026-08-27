---
name: media-gen
description: >
  Photoreal image + video generation and upscaling via fal.ai (pay-per-use, one
  API key, always-current models: Kling, Seedance, FLUX, nano-banana Pro, Topaz).
  Use for image-to-video ("animate this image", "turn this photo into a video"),
  photoreal video clips for websites/demos, hero video loops, upscaling
  images/video, or any gen-media need beyond simple local generation. Rewrites
  rough prompts into model-optimized ones, routes to the cheapest model that
  fits, saves outputs locally. NOT for code-rendered motion graphics or
  scroll-driven cinematic flythroughs — that needs dedicated tooling this
  plugin doesn't ship. For simple illustrations/UI imagery, a separate
  Gemini-based image skill (if the user has one installed) is usually cheaper —
  reach for media-gen when a named fal.ai model, image-to-video, photoreal
  quality, or upscaling is actually needed. ("nano-banana Pro" below is a
  fal.ai model slug, unrelated to any separately-installed nano-banana skill.)
---

# media-gen — fal.ai cost-router

One fal.ai key covers every current image/video model, pay-per-use — no
subscription, no monthly minimum. You prepay credit on fal.ai's dashboard and
each request draws down from it: **spend is real money — be surgical.**

## Auth

Read the key from the environment first; fall back to the hub's `.env` (the
`/jarvis-setup` page's Media section writes it there). The hub itself
resolves the same way the SessionStart hook does: `JARVIS_HUB` env var first,
else the pointer file at `~/.jarvis-hub-path` written by `/jarvis-setup`,
else `~/jarvis-hub`. Never hardcode a path to it and never echo/print/log the
value:

```bash
hub="${JARVIS_HUB:-$(cat ~/.jarvis-hub-path 2>/dev/null)}"
hub="${hub:-$HOME/jarvis-hub}"
FAL_KEY="${FAL_KEY:-$(grep '^FAL_KEY=' "$hub/.env" 2>/dev/null | cut -d= -f2-)}"
```

If `FAL_KEY` is still empty after that, stop and tell the user to add it via
`/jarvis-setup` — do not hunt for it elsewhere. Every request:
header `Authorization: Key $FAL_KEY`.

## Cost discipline (the point of this skill)

- **Images are cheap** (fractions of a cent). Iterate freely.
- **Video bills per second.** Default 3–5s, never more without an explicit ask.
  5s vs 10s = real dollars. State the model + estimated cost BEFORE a video run
  and get the user's go-ahead unless they already gave one this session.
- Cheapest-fit routing: draft/test → FLUX schnell; final image → FLUX dev or
  nano-banana Pro; image→video → Kling (best value) before Seedance (pricier);
  upscale → Topaz only when the target actually needs it.
- No balance API — track spend at https://fal.ai/dashboard (billing page).

## Model routing

Models rotate fast; slugs below verified 2026-07-14. When one 404s or a newer
generation is out, search https://fal.ai/models?q=<term> (WebFetch) — new models
work with the same key + call shape, no skill change.

| Need | Model slug | Notes |
|---|---|---|
| Draft/test image | `fal-ai/flux/schnell` | ~free, 1-4 steps |
| Final image | `fal-ai/flux/dev` | quality tier |
| Photoreal/edit image | `fal-ai/nano-banana-pro` | Gemini-family |
| Image → video | `fal-ai/kling-video/v3/standard/image-to-video` | best cheap; try v-latest |
| Image → video (premium) | `fal-ai/bytedance/seedance` (latest pro) | pricier, smoother camera |
| Two frames → video (interpolate) | `fal-ai/wan-flf2v` (`start_image_url`/`end_image_url`) | cheapest FLF2V, ~$0.2/video @480p, ~$0.4 @720p (verified 2026-08-19). Mid-tier `fal-ai/kling-video/o1/standard/image-to-video` (~$0.084/s, same param names, `end_image_url` optional). Premium `fal-ai/veo3.1/first-last-frame-to-video` (~$0.20/s, **different param names**: `first_frame_url`/`last_frame_url`, `generate_audio` defaults `true` — turn it off) |
| Upscale image | `fal-ai/topaz/upscale` | only on real need |

### Video model economics

Rough per-second cost comparisons circulating in the AI-video community as of
Aug 2026 (credited to Rohit Mithe's "AI Creator Series" notes). These are one
practitioner's numbers, not verified against fal's own billing page — treat
them as a starting hypothesis for routing, and check the live price before a
long job.

| Model | Reported cost | Reported verdict |
|---|---|---|
| Seedance 2.5 | ~$0.34/s | Best in class — realism, acting, prompt adherence, video editing. **720p only.** Highest cost. |
| Seedance 2.0 | below 2.5 | Crisp 1080p/2K, complex shots and VFX |
| Flux 3 | ~$0.17/s | Best raw retro realism; closest to Seedance at half the price |
| MiniMax H3 | $0.13/s @2K, $0.08/s @768p | Cheapest of the good ones, but reportedly "outputs usually look plastic" |
| Kling 3.0 | lowest | Crisp 1080p when **no complex motion** is needed. The default for a simple push-in or drift. |
| Gemini Omni Flash | ~$0.10/s @720p | Video *editing* only — not text-to-video or image-to-video. Best value for talking heads. |

The routing consequence worth keeping: **most everyday clips are a slow
push-in on a still**, which is the "no complex motion" case — so Kling stays
the default and the expensive tiers are for shots with real camera movement or
acting. Note the 720p ceiling on the best model: for a full-bleed website
hero, resolution may matter more than motion quality, which flips the
ranking.

## Call shape

**Sync (images, <60s):**
```bash
curl -s -X POST "https://fal.run/<model-slug>" \
  -H "Authorization: Key $FAL_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"...", "image_size":"landscape_16_9", "num_images":1}'
```

**Queue (video / long jobs):** POST the same body to
`https://queue.fal.run/<model-slug>` → response has `status_url` + `response_url`
→ poll status every ~10s until `COMPLETED` → GET response_url.
Image→video body: `{"prompt":"...", "image_url":"<https-url-or-data-uri>", "duration":"5"}`
(field names vary per model — on a 422, GET `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<model-slug>` for the exact schema).

## Prompt rewriting (always do this)

The user gives a rough ask; rewrite before sending:
- Image: subject + style + lighting + composition + negative cues. A
  non-English ask → translate to an English prompt (models are English-tuned);
  NEVER put text in the image, especially non-Latin scripts.
- **Photoreal image or any image→video first frame:** build the prompt on a
  four-part cinematic formula — medium (photo/render/style) → content
  (subject + action) → frame (camera, lens, composition) → mood (lighting,
  palette, atmosphere) — naming the camera body, lens, lighting, and palette
  explicitly rather than leaving them implicit. Video bills per second, so a
  weak prompt costs real money on the reroll — this is where prompt quality
  has a price tag attached.
- Video: motion verbs + camera direction ("slow push-in", "orbit left"), one
  action per clip, explicit duration, "no audio" unless asked.
- **Image→video: fix the input frame before you spend a second of video.** The
  still constrains the clip more than the video model does — a weak frame on
  the best model is a weak clip, a strong frame on the cheapest model reads as
  footage. Iterating the still is nearly free; iterating the clip is billed
  per second. If the source image is soft, badly lit, or has no depth cue for
  the camera to move through, fix the still first — with whatever image tool
  is available (a separate image-generation skill, or media-gen's own image
  models above) — before spending on video. This is the single largest cost
  lever in this skill.

## Outputs

fal URLs expire — download immediately:
```bash
mkdir -p ~/Downloads/media-gen && curl -s -o ~/Downloads/media-gen/$(date +%Y-%m-%d)-<slug>.<ext> "<result-url>"
```
Reply with the local path.

## Boundaries

- Images for UI/illustration: if the user has a Gemini-based image skill
  installed separately (not bundled with this plugin), prefer it first for
  simple illustrations/UI graphics — it's usually cheaper. Reach for
  media-gen when a named fal.ai model, image→video, photoreal quality the
  other tool can't hit, or upscaling is actually needed.
- Commercial/client-facing use: fal outputs are commercially usable on paid
  credits, but check the specific model's terms page once per new model
  before shipping to a paying client.
