# Code Execution Visualizer

An educational, browser-based code execution visualizer for:

- JavaScript
- TypeScript
- C
- C++

The app simulates step-by-step execution and exposes internal runtime state so beginners can learn how code behaves in memory and in the call stack.

## Project Structure

- `frontend/`: React + TypeScript visualizer application

## Run Locally

1. `cd frontend`
2. `npm install`
3. `npm run dev`

Open the URL printed by Vite.

## Core Features

- Step-by-step execution timeline
- Highlighted active source line in Monaco editor
- Call stack animation and frame push/pop states
- Stack memory and heap memory inspection
- Variable tracking with scope + addresses
- Pointer/reference behavior for C/C++ style samples
- Data structure snapshots for arrays, objects, and struct-like values
- Interpreter diagnostics for unsupported statements

## Advanced Debugger Features

- Play/Pause, Step Forward, Step Backward, Reset
- Timeline scrubber slider (jump to any step)
- Playback speed control (slow to fast stepping)
- Breakpoint line input (comma-separated line numbers)
- Jump to next breakpoint action
- Scope filter for stack memory inspection
- Watch expressions panel with live expression values
- State delta panel showing variable changes between steps
- Runtime metrics cards (current line, frames, heap cells, structures)
- Event loop visualization for JavaScript and TypeScript
- Separate Web APIs, Microtask Queue, and Macrotask Queue panels
- Console output panel with ordered runtime logs
- Step insight cards showing phase, task, scope, queues, and live references
- Step anatomy narration explaining why the next work item runs

## Safety and Execution Model

- Frontend-only architecture (no backend required)
- Uses a deterministic tracing engine for a supported educational subset of each language
- No direct native code execution in the browser; C/C++ are visualized through the same trace model for safe learning

## Notes

- The visualizer focuses on clarity and learning, not full compiler compatibility.
- If a statement is outside the supported subset, it is listed in diagnostics while execution continues.