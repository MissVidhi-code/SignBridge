# SignBridge

Real-time sign language to text and speech, running entirely in your browser.

Sign into your webcam and SignBridge turns hand shapes into letters, words and spoken audio. It has built-in ASL fingerspelling and a teach mode, so you can train it on any other sign language (ISL, BSL, a local dialect, even single-word or two-handed signs).

**Live demo:** [add link here]
**Demo video / GIF:** [add here]

## Why

Interpreters are scarce, and most sign language tools target only one language. SignBridge started as an idea at a school competition: a tool that works for people who do not know sign language, and that any community can teach its own signs to.

## Features

- Real-time webcam recognition with up to **two hands** tracked
- **Built-in ASL fingerspelling (A-Z)**, including the motion letters J and Z
- **Teach mode:** record your own signs (single or two-handed) for any sign language, such as ISL
- Words or single letters: a taught sign can be a letter ("A") or a whole word ("HELLO")
- **Text-to-speech** with a per-language voice (e.g. `en-IN`, `hi-IN`)
- Profiles saved in the browser and **exportable/importable as JSON**
- **Private by design:** video is processed locally and never uploaded

## How it works

**Hand tracking:** MediaPipe Hands gives 21 landmarks per hand.

**Built-in ASL (`asl.js`):** a rule-based classifier, no training data.
- Every distance is divided by hand size, so it does not depend on how far you sit from the camera.
- A finger counts as "extended" by comparing wrist-to-tip with wrist-to-knuckle distance, so it works at any hand rotation.
- Thumb position is measured inside the palm (index side to pinky side), so left hand, right hand and mirrored video all work.
- Rules are grouped by which fingers are extended (e.g. only index up: D, L, G, Q).
- **J and Z** are motion signs: the fingertip path is tracked for about 1.4 s and matched against a J or Z shape.

**Teach mode (`app_v2.js`):** a k-nearest-neighbour classifier.
- Each frame becomes a 128-number vector: hand 1 (63) + hand 2 (63) + relative position of hand 2 (2), all relative to the wrist and divided by hand size.
- Clicking "Teach this sign" records 30 frames. Recognition uses the 5 nearest samples with distance-weighted voting.
- If the nearest sample is too far away, the sign is rejected as "unknown" instead of guessing.

A sign must be held steady for 1.5 s before it is typed, which prevents accidental letters.

## Run it locally

No build step. Camera access needs `localhost` or HTTPS, so serve the folder:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` and press **Start camera**.

Files: `index.html` (UI), `asl.js` (ASL classifier), `app_v2.js` (camera, teach mode, kNN, speech).

## Teaching your own sign language (e.g. ISL)

1. Choose **+ New language**, give it a name and a voice code (e.g. `en-IN`).
2. Type a sign name, make the sign, click **Teach this sign**, and hold it through the countdown.
3. Teach each sign 2-3 times from slightly different angles for better accuracy.
4. Use **Export** to back up or share the language file.

## Limitations

- **ISL is not built in.** The built-in mode is ASL fingerspelling only; ISL works only for signs you teach it.
- **No accuracy benchmark yet.** This is a working prototype and has not been evaluated on a labelled dataset.
- A, S, E, T, N and M are all fist shapes that differ only by thumb position, so a single camera cannot always separate them. Teach mode is the workaround.
- Taught signs are matched per hand orientation; a sign taught with the right hand will not match the left.
- Only static hand shapes plus J and Z motion. No facial expression, body movement or full sentence grammar.
- Accuracy depends on lighting, camera quality and distance.

## Future work

- Measure per-letter accuracy and publish it
- Mirror-invariant matching for left/right hands
- Motion-based taught signs (sequence of frames, not a single pose)
- Preloaded ISL alphabet

## Tech

JavaScript, MediaPipe Hands, Web Speech API, localStorage. No backend.
