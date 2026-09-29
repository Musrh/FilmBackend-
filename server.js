import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Cinema AI backend fonctionne."
  });
});

app.post("/api/generate", (req, res) => {
  const sceneData = req.body;

  if (!sceneData || !sceneData.scene) {
    return res.status(400).json({
      success: false,
      message: "Données de scène manquantes."
    });
  }

  console.log("Données de scène reçues :", sceneData);

  res.json({
    success: true,
    message: "Données de scène reçues correctement.",
    received: {
      sceneId: sceneData.scene.id,
      characters: sceneData.characters?.length || 0,
      locations: sceneData.locations?.length || 0,
      movements: sceneData.movements?.length || 0
    }
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Cinema AI backend démarré sur le port ${PORT}`);
});
