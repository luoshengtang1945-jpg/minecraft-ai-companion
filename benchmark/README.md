# Local Ollama model benchmark

This directory is deliberately separate from production code. `run.js` performs
the real-model A/B benchmark and writes raw request-level data to
`results/latest.json`. It does not change model routing or Minecraft behavior.

Run from the repository root:

```powershell
node benchmark/run.js
```

The full run uses hundreds of local Ollama requests and can take tens of
minutes. Inputs are seeded and identical across completed conditions. The
thinking-enabled 27B condition is gated by a three-request viability preflight.

`results/REPORT.md` may contain a locally generated report. The entire results
directory is intentionally ignored and is not included in a fresh clone.
