# Local visual benchmark

This benchmark sends real PNG files directly to the configured local
`qwen3-vl:8b` Ollama model and validates every answer with the production visual
schema. Images and results stay local and are not committed.

```powershell
node benchmark/vision/run.js --count=3 `
  --case=open_grassland="C:\path\grassland.png" `
  --case=cave_like="C:\path\cave.png"
```

Use labels that describe the expected category, then inspect each saved
observation rather than treating schema validity as semantic correctness.
Results are written below `benchmark/vision/results/`, which is git-ignored.
