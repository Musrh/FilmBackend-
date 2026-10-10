

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@gradio/client";
import ffmpegPath from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);

const HF_TOKEN = process.env.HF_TOKEN;

const HF_SPACE =
  process.env.HF_SPACE ||
  "zerogpu-aoti/wan2-2-fp8da-aoti-faster";

const WAN_TIMEOUT_MS = 8 * 60 * 1000;

const WAN_MAX_SEGMENT_DURATION = 5;

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;

const uploadsDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadsDir, { recursive: true });

app.set("trust proxy", 1);

app.use(
  cors({
    origin: "*",
  })
);

app.use(
  express.json({
    limit: "50mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  })
);

app.use(
  "/uploads",
  express.static(uploadsDir)
);

// ============================================================
// MULTER / UPLOADS
// ============================================================

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(
      /[^a-zA-Z0-9._-]/g,
      "-"
    );

    cb(
      null,
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}-${safe}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_UPLOAD_SIZE,
  },
});

// ============================================================
// HELPERS
// ============================================================

function numberOr(value, fallback) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function booleanOr(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (
    value === "true" ||
    value === 1 ||
    value === "1"
  ) {
    return true;
  }

  if (
    value === "false" ||
    value === 0 ||
    value === "0"
  ) {
    return false;
  }

  return fallback;
}

function formatEta(eta) {
  const n = Number(eta);

  if (!Number.isFinite(n)) {
    return "?";
  }

  return n < 60
    ? `${Math.round(n)}s`
    : `${Math.round(n / 60)}min`;
}

// ============================================================
// DETECTION QUOTA ZEROGPU
// ============================================================

function parseQuotaError(message) {
  if (!message) {
    return {
      isQuotaError: false,
      requestedSeconds: null,
      remainingSeconds: null,
      retryAfter: null,
      retryAfterSeconds: null,
    };
  }

  const text = String(message);

  const isQuotaError =
    /exceeded your ZeroGPU quota/i.test(text) ||
    /ZeroGPU quota/i.test(text) ||
    /requested.*left/i.test(text) ||
    /quota.*left/i.test(text);

  if (!isQuotaError) {
    return {
      isQuotaError: false,
      requestedSeconds: null,
      remainingSeconds: null,
      retryAfter: null,
      retryAfterSeconds: null,
    };
  }

  // Exemple :
  // (154s requested vs. 51s left)
  const quotaMatch = text.match(
    /\(\s*(\d+(?:\.\d+)?)s\s+requested\s+vs\.\s*(\d+(?:\.\d+)?)s\s+left\s*\)/i
  );

  // Exemple :
  // Try again in 12:26:15
  const retryMatch = text.match(
    /Try again in\s+(\d+):(\d{2}):(\d{2})/i
  );

  let retryAfterSeconds = null;

  if (retryMatch) {
    const hours = Number(retryMatch[1]);
    const minutes = Number(retryMatch[2]);
    const seconds = Number(retryMatch[3]);

    retryAfterSeconds =
      hours * 3600 +
      minutes * 60 +
      seconds;
  }

  return {
    isQuotaError: true,

    requestedSeconds: quotaMatch
      ? Number(quotaMatch[1])
      : null,

    remainingSeconds: quotaMatch
      ? Number(quotaMatch[2])
      : null,

    retryAfter: retryMatch
      ? retryMatch[0].replace(
          /^Try again in\s+/i,
          ""
        )
      : null,

    retryAfterSeconds,
  };
}

// ============================================================
// EXTRACTION VIDEO GRADIO / WAN
// ============================================================

function extractVideoValue(value) {
  if (!value) {
    return null;
  }

  // ----------------------------------------------------------
  // Chaîne
  // ----------------------------------------------------------

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    if (
      /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(
        trimmed
      )
    ) {
      return trimmed;
    }

    return null;
  }

  // ----------------------------------------------------------
  // Tableau
  // ----------------------------------------------------------

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = extractVideoValue(item);

      if (result) {
        return result;
      }
    }

    return null;
  }

  // ----------------------------------------------------------
  // Objet
  // ----------------------------------------------------------

  if (
    typeof value === "object" &&
    value !== null
  ) {
    const candidates = [
      value.url,
      value.video,
      value.path,
      value.file,
      value.name,
    ];

    for (const candidate of candidates) {
      const result =
        extractVideoValue(candidate);

      if (result) {
        return result;
      }
    }

    for (const key of Object.keys(value)) {
      const result =
        extractVideoValue(value[key]);

      if (result) {
        return result;
      }
    }
  }

  return null;
}

// ============================================================
// IMAGE HANDLING
// ============================================================

function normalizeImageUrl(value) {
  if (
    !value ||
    typeof value !== "string"
  ) {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (value.startsWith("/uploads/")) {
    return value;
  }

  if (value.startsWith("uploads/")) {
    return `/${value}`;
  }

  return value;
}

function findFirstImage(scene) {
  if (
    !scene ||
    typeof scene !== "object"
  ) {
    return null;
  }

  if (scene.imageUrl) {
    return normalizeImageUrl(
      scene.imageUrl
    );
  }

  if (scene.image) {
    return normalizeImageUrl(
      scene.image
    );
  }

  const getUrl = (image) => {
    if (typeof image === "string") {
      return normalizeImageUrl(image);
    }

    if (
      !image ||
      typeof image !== "object"
    ) {
      return null;
    }

    return normalizeImageUrl(
      image.storageUrl ||
      image.url
    );
  };

  // ----------------------------------------------------------
  // Personnages + lieux
  // ----------------------------------------------------------

  for (const group of [
    scene.characters,
    scene.locations,
  ]) {
    if (!Array.isArray(group)) {
      continue;
    }

    for (const item of group) {
      if (!item) {
        continue;
      }

      for (
        const image of
        item.imageReferences || []
      ) {
        const url = getUrl(image);

        if (url) {
          return url;
        }
      }

      const direct =
        normalizeImageUrl(
          item.imageUrl ||
          item.image
        );

      if (direct) {
        return direct;
      }
    }
  }

  // ----------------------------------------------------------
  // Images de référence de scène
  // ----------------------------------------------------------

  for (
    const image of
    scene.referenceImages || []
  ) {
    const url = getUrl(image);

    if (url) {
      return url;
    }
  }

  // ----------------------------------------------------------
  // Images du style visuel
  // ----------------------------------------------------------

  for (
    const image of
    scene.visualStyle?.images || []
  ) {
    const url = getUrl(image);

    if (url) {
      return url;
    }
  }

  return null;
}

function resolveLocalUploadPath(imageUrl) {
  const relative =
    imageUrl.replace(/^\/+/, "");

  const resolved =
    path.resolve(
      __dirname,
      relative
    );

  const uploadsRoot =
    `${path.resolve(uploadsDir)}${path.sep}`;

  if (
    resolved !== path.resolve(uploadsDir) &&
    !resolved.startsWith(uploadsRoot)
  ) {
    throw new Error(
      "Le chemin de l'image n'est pas autorisé."
    );
  }

  return resolved;
}

// ============================================================
// VIDEO PROMPT
// ============================================================

function buildVideoPrompt(
  scene,
  { includeAction = true } = {}
) {
  if (
    !scene ||
    typeof scene !== "object"
  ) {
    return "Create a cinematic realistic video.";
  }

  const parts = [];

  // ----------------------------------------------------------
  // Description
  // ----------------------------------------------------------

  if (scene.description) {
    parts.push(
      `Scene description: ${scene.description}`
    );
  }

  // ----------------------------------------------------------
  // Action
  // ----------------------------------------------------------

  if (
    includeAction &&
    scene.action
  ) {
    parts.push(
      `Action and staging: ${scene.action}`
    );
  }

  // ----------------------------------------------------------
  // Personnages
  // ----------------------------------------------------------

  if (
    Array.isArray(scene.characters)
  ) {
    const characters =
      scene.characters
        .filter(Boolean)
        .map((character) => {
          const name =
            character.name ||
            "character";

          return character.description
            ? `${name}: ${character.description}`
            : name;
        })
        .join(", ");

    if (characters) {
      parts.push(
        `Characters: ${characters}`
      );
    }
  }

  // ----------------------------------------------------------
  // Lieux
  // ----------------------------------------------------------

  if (
    Array.isArray(scene.locations)
  ) {
    const locations =
      scene.locations
        .filter(Boolean)
        .map(
          (location) =>
            location.name ||
            location.title ||
            location.description ||
            ""
        )
        .filter(Boolean)
        .join(", ");

    if (locations) {
      parts.push(
        `Locations: ${locations}`
      );
    }
  }

  // ----------------------------------------------------------
  // Mouvements
  // ----------------------------------------------------------

  if (
    Array.isArray(scene.movements)
  ) {
    const movements =
      scene.movements
        .filter(Boolean)
        .map((movement) => {
          const action =
            movement.action ||
            movement.name ||
            movement.description ||
            "";

          return `${action}${
            movement.destination
              ? ` toward ${movement.destination}`
              : ""
          }`;
        })
        .filter(Boolean)
        .join(". ");

    if (movements) {
      parts.push(
        `Movement sequence: ${movements}`
      );
    }
  }

  // ----------------------------------------------------------
  // Dialogue
  // ----------------------------------------------------------

  if (scene.dialogue) {
    parts.push(
      `Dialogue context: ${scene.dialogue}`
    );
  }

  // ----------------------------------------------------------
  // Style
  // ----------------------------------------------------------

  const style =
    typeof scene.visualStyle === "string"
      ? scene.visualStyle
      : scene.visualStyle?.text ||
        "";

  if (style) {
    parts.push(
      `Visual style: ${style}`
    );
  }

  // ----------------------------------------------------------
  // Consignes cinéma
  // ----------------------------------------------------------

  parts.push(
    "Cinematic realistic video, natural human movement, realistic facial expressions, realistic body proportions, coherent environment, cinematic lighting, subtle camera movement, consistent characters and locations, high visual quality."
  );

  return parts.join("\n\n");
}

// ============================================================
// SEGMENTATION
// ============================================================

function splitDurationIntoSegments(totalDuration) {
  const requested = Math.max(
    numberOr(totalDuration, 1),
    1
  );

  // Test temporaire : 5 secondes = 2 s + 3 s.
  if (Math.abs(requested - 5) < 0.01) {
    return [2, 3];
  }

  // Comportement normal pour toutes les autres durées.
  let remaining = requested;
  const segments = [];

  while (remaining > 0) {
    const segmentDuration = Math.min(
      remaining,
      WAN_MAX_SEGMENT_DURATION
    );

    segments.push(
      Number(segmentDuration.toFixed(2))
    );

    remaining = Number(
      (remaining - segmentDuration).toFixed(2)
    );
  }

  return segments;
}

// ============================================================
// PHRASES
// ============================================================

function splitTextIntoSentences(text) {
  if (
    !text ||
    typeof text !== "string"
  ) {
    return [];
  }

  return text
    .replace(/\s+/g, " ")
    .split(
      /(?<=[.!?。！？])\s+/
    )
    .map((x) => x.trim())
    .filter(Boolean);
}

// ============================================================
// MOUVEMENTS
// ============================================================

function getMovementDescriptions(scene) {
  if (
    !Array.isArray(
      scene?.movements
    )
  ) {
    return [];
  }

  return scene.movements
    .filter(Boolean)
    .map((movement) => {
      const action =
        movement.action ||
        movement.name ||
        movement.description ||
        "";

      return `${action}${
        movement.destination
          ? ` toward ${movement.destination}`
          : ""
      }`.trim();
    })
    .filter(Boolean);
}

// ============================================================
// PROMPTS AUTOMATIQUES PAR SEGMENT
// ============================================================

function buildAutomaticSegmentPrompts(
  scene,
  basePrompt,
  durations
) {
  const timeline =
    splitTextIntoSentences(
      scene?.action || ""
    );

  timeline.push(
    ...getMovementDescriptions(
      scene
    ).map(
      (movement) =>
        `Movement: ${movement}`
    )
  );

  const count =
    durations.length;

  return durations.map(
    (duration, index) => {
      const start =
        Math.floor(
          (index *
            timeline.length) /
            count
        );

      const end =
        Math.max(
          start + 1,
          Math.floor(
            ((index + 1) *
              timeline.length) /
              count
          )
        );

      const focus =
        timeline
          .slice(start, end)
          .join(" ");

      const continuity =
        index === 0
          ? "This is the beginning of the scene. Establish the environment and begin the action naturally."
          : "Direct continuation of the previous segment. Do not restart or reset the scene. Preserve character identity, clothing, environment, lighting, camera style and spatial continuity. Continue naturally from the incoming reference frame.";

      return [
        basePrompt,

        `Internal segment ${
          index + 1
        }/${count}, duration ${duration} seconds.`,

        continuity,

        focus
          ? `Focus for this segment: ${focus}`
          : "Continue the original action naturally.",

        "Keep temporal continuity and realistic cinematic motion.",
      ].join("\n\n");
    }
  );
}

// ============================================================
// FFMPEG
// ============================================================

function runFfmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        return reject(
          new Error(
            "FFmpeg n'est pas disponible. Installez ffmpeg-static."
          )
        );
      }

      const child =
        spawn(
          ffmpegPath,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
          }
        );

      let stderr = "";

      child.stderr.on(
        "data",
        (chunk) => {
          stderr +=
            chunk.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `FFmpeg a échoué (code ${code}). ${stderr.slice(
                  -3000
                )}`
              )
            );
          }
        }
      );
    }
  );
}

// ============================================================
// EXTRACTION DERNIÈRE FRAME
// ============================================================

async function extractLastFrame(
  videoPath
) {
  const filename =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(
        2,
        8
      )}-last-frame.jpg`;

  const output =
    path.join(
      uploadsDir,
      filename
    );

  await runFfmpeg([
    "-y",
    "-sseof",
    "-0.2",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    output,
  ]);

  return {
    buffer:
      fs.readFileSync(
        output
      ),

    path: output,
  };
}

// ============================================================
// CONCATÉNATION DES SEGMENTS
// ============================================================

async function concatenateVideos(
  videoPaths,
  req
) {
  const listPath =
    path.join(
      uploadsDir,
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(
          2,
          8
        )}-concat.txt`
    );

  const finalFilename =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(
        2,
        8
      )}-scene.mp4`;

  const finalPath =
    path.join(
      uploadsDir,
      finalFilename
    );

  const lines =
    videoPaths
      .map(
        (p) =>
          `file '${p.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n") +
    "\n";

  fs.writeFileSync(
    listPath,
    lines,
    "utf8"
  );

  try {
    // --------------------------------------------------------
    // Première tentative : sans réencodage
    // --------------------------------------------------------

    try {
      await runFfmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        finalPath,
      ]);
    } catch (copyError) {
      console.warn(
        "Concat sans réencodage échoué. Fallback H264:",
        copyError.message
      );

      // ------------------------------------------------------
      // Fallback H264
      // ------------------------------------------------------

      await runFfmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-an",
        "-movflags",
        "+faststart",
        finalPath,
      ]);
    }
  } finally {
    try {
      fs.unlinkSync(
        listPath
      );
    } catch {}
  }

  return {
    path: finalPath,

    url:
      `${req.protocol}://${req.get(
        "host"
      )}/uploads/${finalFilename}`,
  };
}

// ============================================================
// WAN : GÉNÉRER UN SEGMENT
// ============================================================

async function generateWanClip({
  client,
  imageBuffer,
  prompt,
  duration,
  steps,
  guidanceScale,
  guidanceScale2,
  seed,
  randomizeSeed,
}) {
  console.log(
    `Soumission Wan segment (${duration}s)...`
  );

  const job =
    client.submit(
      "/generate_video",
      [
        imageBuffer,
        prompt,
        steps,
        "blurry, low quality, distorted face, deformed body, extra limbs, bad anatomy, text, watermark",
        duration,
        guidanceScale,
        guidanceScale2,
        seed,
        randomizeSeed,
      ]
    );

  const result =
    await waitForWanJob(
      job
    );

  return result.video;
}

// ============================================================
// WAN : ATTENDRE LE JOB
// ============================================================

async function waitForWanJob(
  job
) {
  const startedAt =
    Date.now();

  return new Promise(
    (resolve, reject) => {
      let settled = false;
      let finalVideo = null;
      let lastStatus = null;
      let dataReceived = false;
      let graceTimer = null;

      const finish = (
        fn,
        value
      ) => {
        if (settled) {
          return;
        }

        settled = true;

        clearTimeout(
          timeoutTimer
        );

        clearTimeout(
          graceTimer
        );

        fn(value);
      };

      const timeoutTimer =
        setTimeout(
          () => {
            try {
              job?.cancel?.();
            } catch {}

            finish(
              reject,
              new Error(
                `Wan 2.2 n'a pas terminé après ${
                  WAN_TIMEOUT_MS /
                  60000
                } minutes.`
              )
            );
          },
          WAN_TIMEOUT_MS
        );

      const iterator =
        job?.[
          Symbol.asyncIterator
        ]?.() || job;

      (async () => {
        try {
          while (!settled) {
            const {
              value: message,
              done,
            } =
              await iterator.next();

            if (done) {
              break;
            }

            if (!message) {
              continue;
            }

            // ------------------------------------------------
            // STATUS
            // ------------------------------------------------

            if (
              message.type ===
              "status"
            ) {
              lastStatus =
                message;

              const stage =
                message.stage ||
                message.status ||
                "unknown";

              const elapsed =
                Math.round(
                  (
                    Date.now() -
                    startedAt
                  ) / 1000
                );

              console.log(
                `[WAN STATUS] stage=${stage} | position=${
                  message.position ??
                  "?"
                } | queue=${
                  message.size ??
                  message.queue_size ??
                  "?"
                } | ETA=${formatEta(
                  message.eta
                )} | elapsed=${elapsed}s`
              );

              // ------------------------------------------------
              // Erreur Wan
              // ------------------------------------------------

              if (
                stage ===
                "error"
              ) {
                const errorMessage =
                  message.message ||
                  message.error ||
                  message.code ||
                  "Erreur signalée par Wan 2.2.";

                return finish(
                  reject,
                  new Error(
                    errorMessage
                  )
                );
              }

              // ------------------------------------------------
              // Job terminé
              // ------------------------------------------------

              if (
                stage ===
                "complete"
              ) {
                if (
                  finalVideo
                ) {
                  return finish(
                    resolve,
                    {
                      video:
                        finalVideo,

                      status:
                        message,
                    }
                  );
                }

                // Laisser 15 secondes
                // pour recevoir le data final.

                graceTimer =
                  setTimeout(
                    () => {
                      if (
                        finalVideo
                      ) {
                        finish(
                          resolve,
                          {
                            video:
                              finalVideo,

                            status:
                              lastStatus,
                          }
                        );
                      } else {
                        finish(
                          reject,
                          new Error(
                            dataReceived
                              ? "Wan 2.2 a terminé, mais aucune URL vidéo exploitable n'a été trouvée."
                              : "Wan 2.2 a terminé sans renvoyer de vidéo."
                          )
                        );
                      }
                    },
                    15000
                  );
              }
            }

            // ------------------------------------------------
            // DATA
            // ------------------------------------------------

            if (
              message.type ===
              "data"
            ) {
              dataReceived =
                true;

              console.log(
                "[WAN DATA] Résultat reçu."
              );

              const video =
                extractVideoValue(
                  message.data
                );

              if (video) {
                finalVideo =
                  video;

                console.log(
                  "[WAN DATA] Vidéo détectée:",
                  video
                );

                return finish(
                  resolve,
                  {
                    video,

                    status:
                      lastStatus,
                  }
                );
              }

              let rawData = "";

              try {
                rawData =
                  JSON.stringify(
                    message.data
                  );
              } catch {
                rawData =
                  String(
                    message.data
                  );
              }

              console.log(
                "[WAN DATA] Aucune vidéo détectée."
              );

              console.log(
                "[WAN DATA] Brut:",
                rawData.slice(
                  0,
                  5000
                )
              );
            }
          }

          // --------------------------------------------------
          // FIN ITERATEUR
          // --------------------------------------------------

          if (
            finalVideo
          ) {
            return finish(
              resolve,
              {
                video:
                  finalVideo,

                status:
                  lastStatus,
              }
            );
          }

          finish(
            reject,
            new Error(
              "Le job Wan 2.2 est terminé mais aucune vidéo n'a été retournée."
            )
          );
        } catch (error) {
          finish(
            reject,
            error
          );
        }
      })();
    }
  );
}

// ============================================================
// DOWNLOAD VIDEO WAN
// ============================================================

async function downloadRemoteFile(
  url
) {
  if (
    !url ||
    typeof url !== "string"
  ) {
    throw new Error(
      "URL de fichier distante invalide."
    );
  }

  // ----------------------------------------------------------
  // URL HTTP/HTTPS
  // ----------------------------------------------------------

  if (
    !/^https?:\/\//i.test(url)
  ) {
    throw new Error(
      `Le résultat Wan n'est pas une URL HTTP exploitable: ${url}`
    );
  }

  const headers =
    HF_TOKEN
      ? {
          Authorization:
            `Bearer ${HF_TOKEN}`,
        }
      : {};

  const response =
    await fetch(
      url,
      {
        headers,
      }
    );

  if (!response.ok) {
    throw new Error(
      `Téléchargement impossible. HTTP ${response.status}`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

// ============================================================
// SAUVEGARDE VIDÉO LOCALE
// ============================================================

async function saveVideoLocally(
  videoUrl,
  req,
  suffix = "wan"
) {
  const buffer =
    await downloadRemoteFile(
      videoUrl
    );

  const filename =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(
        2,
        8
      )}-${suffix}.mp4`;

  fs.writeFileSync(
    path.join(
      uploadsDir,
      filename
    ),
    buffer
  );

  console.log(
    "Vidéo enregistrée:",
    filename,
    buffer.length,
    "bytes"
  );

  return `${req.protocol}://${req.get(
    "host"
  )}/uploads/${filename}`;
}

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (_req, res) => {
    res.json({
      success: true,

      service:
        "Cinema AI Backend",

      status:
        "online",

      wanSpace:
        HF_SPACE,

      wanTimeoutMinutes:
        WAN_TIMEOUT_MS /
        60000,

      wanMaxSegmentDuration:
        WAN_MAX_SEGMENT_DURATION,
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      success: true,

      status:
        "ok",

      hfConfigured:
        Boolean(HF_TOKEN),

      wanSpace:
        HF_SPACE,
    });
  }
);

// ============================================================
// TEST HUGGING FACE
// ============================================================

app.get(
  "/api/test-huggingface",
  async (_req, res) => {
    try {
      if (!HF_TOKEN) {
        return res
          .status(500)
          .json({
            success: false,

            error:
              "HF_TOKEN n'est pas configuré.",
          });
      }

      await Client.connect(
        HF_SPACE,
        {
          token:
            HF_TOKEN,

          events: [
            "data",
            "status",
          ],
        }
      );

      res.json({
        success: true,

        message:
          "Connexion Hugging Face réussie.",

        space:
          HF_SPACE,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          success: false,

          error:
            error.message ||
            "Connexion Hugging Face impossible.",
        });
    }
  }
);

// ============================================================
// UPLOAD ASSETS
// ============================================================

app.post(
  "/api/assets",
  upload.fields([
    {
      name: "image",
      maxCount: 1,
    },

    {
      name: "file",
      maxCount: 1,
    },
  ]),
  (req, res) => {
    try {
      const file =
        req.files?.image?.[0] ||
        req.files?.file?.[0];

      if (!file) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Aucun fichier image reçu.",
          });
      }

      const publicUrl =
        `${req.protocol}://${req.get(
          "host"
        )}/uploads/${encodeURIComponent(
          file.filename
        )}`;

      return res.json({
        success: true,

        message:
          "Image reçue correctement.",

        asset: {
          id:
            `${Date.now()}-${Math.random()
              .toString(36)
              .slice(
                2,
                10
              )}`,

          name:
            file.originalname,

          filename:
            file.filename,

          mimetype:
            file.mimetype,

          size:
            file.size,

          url:
            publicUrl,

          storageUrl:
            publicUrl,

          uploaded:
            true,
        },
      });
    } catch (error) {
      res
        .status(500)
        .json({
          success: false,

          message:
            error.message ||
            "Erreur serveur pendant l'upload.",
        });
    }
  }
);

// ============================================================
// GENERATION VIDÉO
// ============================================================

app.post(
  "/api/generate-video",
  async (req, res) => {
    const startedAt =
      Date.now();

    try {
      if (!HF_TOKEN) {
        return res
          .status(500)
          .json({
            success: false,

            error:
              "HF_TOKEN n'est pas configuré dans l'environnement.",

            code:
              "HF_TOKEN_MISSING",
          });
      }

      const {
        scene,
        sceneData,
        imageUrl,
        prompt,
        duration,
        steps,
        guidanceScale,
        guidanceScale2,
        seed,
        randomizeSeed,
      } = req.body || {};

      const data =
        sceneData ||
        scene ||
        {};

      // ------------------------------------------------------
      // DURÉE DEMANDÉE
      // ------------------------------------------------------

      const requestedDuration =
        Math.max(
          numberOr(
            duration ??
              data.duration,
            5
          ),
          1
        );

      // ------------------------------------------------------
      // DÉCOUPAGE AUTOMATIQUE
      // ------------------------------------------------------

      const segmentDurations =
        splitDurationIntoSegments(
          requestedDuration
        );

      console.log(
        "=========================================="
      );

      console.log(
        `GÉNÉRATION SCÈNE: ${requestedDuration}s`
      );

      console.log(
        `SEGMENTS: ${segmentDurations.join(
          " + "
        )}s`
      );

      console.log(
        "=========================================="
      );

      // ------------------------------------------------------
      // IMAGE INITIALE
      // ------------------------------------------------------

      const finalImageUrl =
        normalizeImageUrl(
          imageUrl ||
            findFirstImage(data)
        );

      if (!finalImageUrl) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Aucune image de référence n'a été trouvée pour cette scène.",

            code:
              "REFERENCE_IMAGE_MISSING",
          });
      }

      let imageBuffer;

      if (
        /^https?:\/\//i.test(
          finalImageUrl
        )
      ) {
        imageBuffer =
          await downloadRemoteFile(
            finalImageUrl
          );
      } else {
        const localPath =
          resolveLocalUploadPath(
            finalImageUrl
          );

        if (
          !fs.existsSync(
            localPath
          )
        ) {
          throw new Error(
            `Image introuvable: ${localPath}`
          );
        }

        imageBuffer =
          fs.readFileSync(
            localPath
          );
      }

      // ------------------------------------------------------
      // PARAMÈTRES WAN
      // ------------------------------------------------------

      const finalSteps =
        numberOr(
          steps,
          4
        );

      const finalGuidanceScale =
        numberOr(
          guidanceScale,
          1
        );

      const finalGuidanceScale2 =
        numberOr(
          guidanceScale2,
          1
        );

      const finalSeed =
        numberOr(
          seed,
          42
        );

      const finalRandomizeSeed =
        booleanOr(
          randomizeSeed,
          false
        );

      // ------------------------------------------------------
      // PROMPT GLOBAL
      // ------------------------------------------------------

      const basePrompt =
        prompt ||
        buildVideoPrompt(
          data,
          {
            includeAction:
              false,
          }
        );

      // ------------------------------------------------------
      // PROMPTS SEGMENTS
      // ------------------------------------------------------

      const segmentPrompts =
        buildAutomaticSegmentPrompts(
          data,
          basePrompt,
          segmentDurations
        );

      // ------------------------------------------------------
      // CONNEXION HUGGING FACE
      // ------------------------------------------------------

      console.log(
        "Connexion Hugging Face..."
      );

      const client =
        await Client.connect(
          HF_SPACE,
          {
            token:
              HF_TOKEN,

            events: [
              "data",
              "status",
            ],
          }
        );

      console.log(
        "Connexion Hugging Face réussie."
      );

      // ------------------------------------------------------
      // GÉNÉRATION DES SEGMENTS
      // ------------------------------------------------------

      const segmentPaths = [];

      const segments = [];

      let currentImageBuffer =
        imageBuffer;

      for (
        let index = 0;
        index <
        segmentDurations.length;
        index++
      ) {
        const segmentStarted =
          Date.now();

        const segmentDuration =
          segmentDurations[
            index
          ];

        console.log(
          `========== SEGMENT ${
            index + 1
          }/${
            segmentDurations.length
          } | ${segmentDuration}s ==========`
        );

        console.log(
          "Prompt segment:",
          segmentPrompts[
            index
          ]
        );

        // ----------------------------------------------------
        // SEED
        // ----------------------------------------------------

        const segmentSeed =
          finalRandomizeSeed
            ? Math.floor(
                Math.random() *
                  2147483647
              )
            : finalSeed +
              index;

        // ----------------------------------------------------
        // WAN
        // ----------------------------------------------------

        const remoteVideoUrl =
          await generateWanClip({
            client,

            imageBuffer:
              currentImageBuffer,

            prompt:
              segmentPrompts[
                index
              ],

            duration:
              segmentDuration,

            steps:
              finalSteps,

            guidanceScale:
              finalGuidanceScale,

            guidanceScale2:
              finalGuidanceScale2,

            seed:
              segmentSeed,

            randomizeSeed:
              finalRandomizeSeed,
          });

        if (
          !remoteVideoUrl
        ) {
          throw new Error(
            `Wan 2.2 n'a pas retourné de vidéo pour le segment ${
              index + 1
            }.`
          );
        }

        // ----------------------------------------------------
        // TÉLÉCHARGER LE SEGMENT
        // ----------------------------------------------------

        const segmentFilename =
          `${Date.now()}-${Math.random()
            .toString(36)
            .slice(
              2,
              8
            )}-segment-${
              index + 1
            }.mp4`;

        const segmentPath =
          path.join(
            uploadsDir,
            segmentFilename
          );

        const segmentBuffer =
          await downloadRemoteFile(
            remoteVideoUrl
          );

        fs.writeFileSync(
          segmentPath,
          segmentBuffer
        );

        segmentPaths.push(
          segmentPath
        );

        const segmentElapsed =
          Math.round(
            (
              Date.now() -
              segmentStarted
            ) / 1000
          );

        segments.push({
          index:
            index + 1,

          duration:
            segmentDuration,

          elapsedSeconds:
            segmentElapsed,
        });

        console.log(
          `Segment ${
            index + 1
          } enregistré: ${segmentFilename}`
        );

        // ----------------------------------------------------
        // CONTINUITÉ
        // ----------------------------------------------------

        if (
          index <
          segmentDurations.length -
            1
        ) {
          console.log(
            `Extraction dernière frame du segment ${
              index + 1
            }...`
          );

          const lastFrame =
            await extractLastFrame(
              segmentPath
            );

          currentImageBuffer =
            lastFrame.buffer;

          try {
            fs.unlinkSync(
              lastFrame.path
            );
          } catch {}

          console.log(
            `Dernière frame du segment ${
              index + 1
            } utilisée pour le segment ${
              index + 2
            }.`
          );
        }
      }

      // ------------------------------------------------------
      // ASSEMBLAGE FINAL
      // ------------------------------------------------------

      let finalVideo;

      if (
        segmentPaths.length ===
        1
      ) {
        const filename =
          `${Date.now()}-${Math.random()
            .toString(36)
            .slice(
              2,
              8
            )}-scene.mp4`;

        const destination =
          path.join(
            uploadsDir,
            filename
          );

        fs.copyFileSync(
          segmentPaths[0],
          destination
        );

        finalVideo = {
          path:
            destination,

          url:
            `${req.protocol}://${req.get(
              "host"
            )}/uploads/${filename}`,
        };
      } else {
        console.log(
          "Assemblage des segments avec FFmpeg..."
        );

        finalVideo =
          await concatenateVideos(
            segmentPaths,
            req
          );
      }

      // ------------------------------------------------------
      // SUPPRIMER LES SEGMENTS TEMPORAIRES
      // ------------------------------------------------------

      for (
        const segmentPath of
        segmentPaths
      ) {
        try {
          fs.unlinkSync(
            segmentPath
          );
        } catch {}
      }

      // ------------------------------------------------------
      // RÉSULTAT
      // ------------------------------------------------------

      const elapsed =
        Math.round(
          (
            Date.now() -
            startedAt
          ) / 1000
        );

      console.log(
        `SCÈNE TERMINÉE: ${requestedDuration}s en ${elapsed}s`
      );

      console.log(
        "Vidéo finale:",
        finalVideo.url
      );

      return res.json({
        success:
          true,

        video:
          finalVideo.url,

        videoUrl:
          finalVideo.url,

        requestedDuration,

        segmentCount:
          segmentDurations.length,

        segments,

        result: {
          video:
            finalVideo.url,

          duration:
            requestedDuration,

          segmentCount:
            segmentDurations.length,

          segments,

          elapsedSeconds:
            elapsed,
        },
      });
    } catch (error) {
      const elapsed =
        Math.round(
          (
            Date.now() -
            startedAt
          ) / 1000
        );

      const message =
        error?.message ||
        String(error);

      console.error(
        "Erreur génération scène Wan 2.2:",
        message
      );

      // ======================================================
      // QUOTA HUGGING FACE ZEROGPU
      // ======================================================

      const quota =
        parseQuotaError(
          message
        );

      if (
        quota.isQuotaError
      ) {
        console.warn(
          "QUOTA ZEROGPU INSUFFISANT."
        );

        console.warn(
          `Demandé: ${quota.requestedSeconds ?? "?"}s`
        );

        console.warn(
          `Restant: ${quota.remainingSeconds ?? "?"}s`
        );

        console.warn(
          `Réessayer dans: ${quota.retryAfter ?? "inconnu"}`
        );

        // HTTP Retry-After
        if (
          Number.isFinite(
            quota.retryAfterSeconds
          )
        ) {
          res.set(
            "Retry-After",
            String(
              quota.retryAfterSeconds
            )
          );
        }

        return res
          .status(429)
          .json({
            success:
              false,

            error:
              "Le quota ZeroGPU Hugging Face est temporairement insuffisant.",

            code:
              "ZEROGPU_QUOTA_EXCEEDED",

            message:
              "La génération vidéo ne peut pas être lancée pour le moment car le quota GPU disponible est insuffisant.",

            requestedSeconds:
              quota.requestedSeconds,

            remainingSeconds:
              quota.remainingSeconds,

            retryAfter:
              quota.retryAfter,

            retryAfterSeconds:
              quota.retryAfterSeconds,

            details:
              message,

            elapsedSeconds:
              elapsed,
          });
      }

      // ======================================================
      // AUTRES ERREURS
      // ======================================================

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Erreur pendant la génération vidéo Wan 2.2.",

          code:
            "VIDEO_GENERATION_ERROR",

          details:
            message,

          elapsedSeconds:
            elapsed,
        });
    }
  }
);

// ============================================================
// COMPATIBILITÉ
// ============================================================

app.post(
  "/api/generate",
  (req, res) => {
    const {
      prompt,
      scene,
    } = req.body || {};

    res.json({
      success:
        true,

      message:
        "Endpoint /api/generate disponible. Utiliser /api/generate-video pour Wan 2.2.",

      prompt:
        prompt || "",

      scene:
        scene || null,
    });
  }
);

// ============================================================
// ERREURS
// ============================================================

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    if (
      error instanceof
      multer.MulterError
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          message:
            `Erreur upload Multer: ${error.code}`,
        });
    }

    console.error(
      "ERREUR SERVEUR:",
      error
    );

    res
      .status(500)
      .json({
        success:
          false,

        message:
          error?.message ||
          "Erreur serveur.",
      });
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      "Cinema AI Backend"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Wan 2.2 timeout: ${
        WAN_TIMEOUT_MS /
        60000
      } minutes`
    );

    console.log(
      `Wan max segment: ${
        WAN_MAX_SEGMENT_DURATION
      }s`
    );

    console.log(
      `Hugging Face Space: ${
        HF_SPACE
      }`
    );

    console.log(
      `HF_TOKEN configuré: ${
        HF_TOKEN
          ? "OUI"
          : "NON"
      }`
    );

    console.log(
      `FFmpeg disponible: ${
        ffmpegPath
          ? "OUI"
          : "NON"
      }`
    );

    console.log(
      "=========================================="
    );
  }
);

