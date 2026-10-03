
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { Client } = require("@gradio/client");

const app = express();

const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, "uploads");

const HF_TOKEN = process.env.HF_TOKEN;

const HF_SPACE = "zerogpu-aoti/wan2-2-fp8da-aoti-faster";

const HF_API_NAME = "/generate_video";


// ======================================================
// DOSSIER UPLOADS
// ======================================================

fs.mkdirSync(uploadsDir, { recursive: true });


// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());

app.use(
  express.json({
    limit: "20mb"
  })
);

app.use("/uploads", express.static(uploadsDir));


// ======================================================
// MULTER
// ======================================================

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (_req, file, cb) => {
    const ext =
      path.extname(file.originalname) || ".jpg";

    const name =
      path
        .basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9_-]/g, "_") ||
      "image";

    cb(
      null,
      `${Date.now()}-${name}${ext}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 20 * 1024 * 1024
  }
});


// ======================================================
// ROUTE PRINCIPALE
// ======================================================

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "Cinema AI backend actif."
  });
});


// ======================================================
// UPLOAD IMAGE
// ======================================================

app.post(
  "/api/assets",
  upload.single("image"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Aucune image reçue."
        });
      }

      const url =
        `${req.protocol}://${req.get("host")}` +
        `/uploads/${encodeURIComponent(req.file.filename)}`;

      res.json({
        success: true,

        asset: {
          id: Date.now(),

          name: req.file.originalname,

          url,

          storageUrl: url,

          ownerType:
            req.body.ownerType || null,

          ownerId:
            req.body.ownerId || null,

          referenceId:
            req.body.referenceId || null
        }
      });

    } catch (error) {
      console.error(
        "Erreur upload image:",
        error
      );

      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);


// ======================================================
// GENERATION VIDEO — HUGGING FACE / WAN 2.2
// ======================================================

app.post(
  "/api/generate-video",
  async (req, res) => {

    try {

      if (!HF_TOKEN) {
        return res.status(500).json({
          success: false,
          message:
            "HF_TOKEN n'est pas configuré sur Railway."
        });
      }


      const {
        imageUrl,
        prompt,
        duration = 3,
        steps = 6,
        guidanceScale = 1,
        guidanceScale2 = 1,
        seed = 42,
        randomizeSeed = true
      } = req.body;


      // --------------------------------------------------
      // VALIDATION
      // --------------------------------------------------

      if (!imageUrl) {
        return res.status(400).json({
          success: false,
          message:
            "imageUrl est obligatoire."
        });
      }


      if (!prompt) {
        return res.status(400).json({
          success: false,
          message:
            "prompt est obligatoire."
        });
      }


      console.log(
        "----------------------------------------"
      );

      console.log(
        "🎬 Nouvelle génération vidéo"
      );

      console.log(
        "Image:",
        imageUrl
      );

      console.log(
        "Prompt:",
        prompt
      );

      console.log(
        "Durée:",
        duration
      );

      console.log(
        "Steps:",
        steps
      );


      // --------------------------------------------------
      // CONNEXION AU SPACE HUGGING FACE
      // --------------------------------------------------

      console.log(
        "Connexion à Hugging Face..."
      );

      const client =
        await Client.connect(
          HF_SPACE,
          {
            hf_token: HF_TOKEN
          }
        );


      console.log(
        "Connexion Hugging Face OK."
      );


      // --------------------------------------------------
      // PARAMÈTRES WAN 2.2
      // --------------------------------------------------

      const negativePrompt =
        "static image, blurry, low quality, " +
        "deformed face, deformed hands, extra fingers, " +
        "bad anatomy, distorted body, text, subtitles, " +
        "watermark, duplicate person";


      /*
        L'ordre correspond à l'interface actuelle
        du Space Wan2.2 14B Fast :

        1. input_image
        2. prompt
        3. steps
        4. negative_prompt
        5. duration_seconds
        6. guidance_scale
        7. guidance_scale_2
        8. seed
        9. randomize_seed
      */

      const inputData = [

        imageUrl,

        prompt,

        Number(steps),

        negativePrompt,

        Number(duration),

        Number(guidanceScale),

        Number(guidanceScale2),

        Number(seed),

        Boolean(randomizeSeed)

      ];


      console.log(
        "Envoi à Wan 2.2..."
      );


      // --------------------------------------------------
      // APPEL DU SPACE
      // --------------------------------------------------

      const result =
        await client.predict(
          HF_API_NAME,
          inputData
        );


      console.log(
        "Wan 2.2 a terminé."
      );


      console.log(
        "Résultat:",
        result
      );


      // --------------------------------------------------
      // RÉSULTAT VIDÉO
      // --------------------------------------------------

      const videoData =
        result?.data?.[0] ?? null;

      const seedUsed =
        result?.data?.[1] ?? null;


      // --------------------------------------------------
      // RÉPONSE
      // --------------------------------------------------

      res.json({

        success: true,

        message:
          "Vidéo générée avec Wan 2.2.",

        provider:
          "Hugging Face ZeroGPU",

        model:
          "Wan2.2 14B I2V",

        space:
          HF_SPACE,

        video:
          videoData,

        seed:
          seedUsed

      });


    } catch (error) {

      console.error(
        "----------------------------------------"
      );

      console.error(
        "❌ ERREUR GENERATION VIDEO"
      );

      console.error(error);


      res.status(500).json({

        success: false,

        message:
          "Erreur pendant la génération vidéo.",

        error:
          error.message || String(error)

      });

    }

  }
);


// ======================================================
// GENERATION / TEST IA EXISTANT
// ======================================================

app.post(
  "/api/generate",
  (req, res) => {

    const data =
      req.body || {};

    const characters =
      Array.isArray(data.characters)
        ? data.characters
        : [];

    const locations =
      Array.isArray(data.locations)
        ? data.locations
        : [];

    const movements =
      Array.isArray(data.movements)
        ? data.movements
        : [];


    const images = [];


    for (const character of characters) {

      for (
        const image
        of character.imageReferences || []
      ) {

        images.push(
          image.url || ""
        );

      }

    }


    for (const location of locations) {

      for (
        const image
        of location.imageReferences || []
      ) {

        images.push(
          image.url || ""
        );

      }

    }


    for (
      const image
      of data.referenceImages || []
    ) {

      images.push(
        image.url || ""
      );

    }


    res.json({

      success: true,

      message:
        "Données de scène reçues correctement.",

      received: {

        sceneId:
          data.scene?.id || null,

        characters:
          characters.length,

        locations:
          locations.length,

        movements:
          movements.length,

        referenceImages:
          Array.isArray(
            data.referenceImages
          )
            ? data.referenceImages.length
            : 0,

        totalImages:
          images.length,

        serverImages:
          images.filter(
            url =>
              url.includes("/uploads/")
          ).length,

        blobImages:
          images.filter(
            url =>
              url.startsWith("blob:")
          ).length

      }

    });

  }
);


// ======================================================
// DEMARRAGE
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Cinema AI backend démarré sur le port ${PORT}`
    );

    console.log(
      `Hugging Face Space: ${HF_SPACE}`
    );

    console.log(
      `HF_TOKEN configuré: ${HF_TOKEN ? "OUI" : "NON"}`
    );

  }
);

