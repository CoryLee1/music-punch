let handPose;
let video;
let hands = [];

let sample;
let soundStarted = false;

const PAL = {
  bg: [230, 229, 227],
  ink: [28, 28, 30],
  inkFaint: [160, 158, 154],
  ghost: [195, 193, 189],
};

let options = {
  maxHands: 2,
  flipped: false,
  runtime: "mediapipe",
  modelType: "full",
  detectorModelUrl: undefined,
  landmarkModelUrl: undefined,
};

function preload() {
  handPose = ml5.handPose(options, modelReady);
  sample = loadSound(
    "sample.wav",
    () => console.log("sample.wav loaded"),
    (err) => console.error("sample.wav failed to load", err)
  );
}

function modelReady() {
  console.log("HandPose Model Loaded!");
}

/** 与 index.html 中 IBM Plex Mono 配套，失败时回退等宽。 */
function setup() {
  const c = createCanvas(640, 480);
  c.parent("wrap");
  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();
  handPose.detectStart(video, gotHands);
  textFont("IBM Plex Mono");
}

function draw() {
  background(...PAL.bg);

  push();
  tint(215, 214, 210, 245);
  image(video, 0, 0, width, height);
  pop();

  fill(234, 233, 231, 140);
  noStroke();
  rect(0, 0, width, height);

  drawGlitchField();
  drawSystemHeader();
  drawIdleGeometry();

  drawStartPrompt();

  if (hands.length > 0) {
    for (let i = 0; i < hands.length; i++) {
      let hand = hands[i];

      drawHandThin(hand);

      let thumb = hand.keypoints[4];
      let indexFinger = hand.keypoints[8];
      let radius = dist(thumb.x, thumb.y, indexFinger.x, indexFinger.y);

      drawPinchConstruct(thumb, indexFinger, radius);

      let minRadius = 20;
      let maxRadius = 220;
      let playbackRate = map(radius, minRadius, maxRadius, 0.5, 2.0);
      playbackRate = constrain(playbackRate, 0.5, 2.0);
      let activationThreshold = 25;
      let volume = radius > activationThreshold ? 0.6 : 0;

      if (soundStarted && sample.isPlaying()) {
        sample.rate(playbackRate);
        sample.amp(volume, 0.08);
      }

      drawDataHUD(thumb, indexFinger, radius, playbackRate, volume);
    }
  } else {
    if (soundStarted && sample.isPlaying()) {
      sample.amp(0, 0.2);
    }
    drawSignalNull();
  }
}

function drawGlitchField() {
  const glyphs = "01/\\[]{}⟨⟩::xx⊹⌁∴Δ";
  textSize(9);
  noStroke();
  for (let i = 0; i < 95; i++) {
    let t = frameCount * 0.012;
    let nx = noise(i * 0.17 + t, i * 0.03);
    let ny = noise(i * 0.19 + 40, i * 0.07 + t);
    let dx = (nx - 0.5) * 1.15;
    let dy = (ny - 0.5) * 0.95;
    let x = width / 2 + dx * min(width, height) * 0.62;
    let y = height / 2 + dy * min(width, height) * 0.52;
    fill(...PAL.ghost, 22 + (i % 7) * 2);
    text(glyphs.charAt(i % glyphs.length), x, y);
  }
}

function drawSystemHeader() {
  textSize(11);
  fill(...PAL.inkFaint);
  noStroke();
  let y = 22;
  text("// SYSTEM: MATRIX_VOID", 14, y);
  text("// RIPPLE: SAMPLE_RATE_BINDING", 14, y + 14);
  text("// VISUAL: GLITCH_BLACK · THIN_STROKE", 14, y + 28);
}

function drawIdleGeometry() {
  let cx = width / 2;
  let cy = height / 2;
  stroke(...PAL.ink, 35);
  strokeWeight(0.6);
  noFill();
  let r = 88 + sin(frameCount * 0.02) * 4;
  drawingContext.setLineDash([3, 7]);
  ellipse(cx, cy, r * 2, r * 2);
  drawingContext.setLineDash([]);
  for (let a = 0; a < TWO_PI; a += PI / 3) {
    line(cx, cy, cx + cos(a) * (r - 6), cy + sin(a) * (r - 6));
  }
}

function drawStartPrompt() {
  if (soundStarted) return;
  let cx = width / 2;
  let cy = height / 2;
  stroke(...PAL.ink, 90);
  strokeWeight(0.75);
  noFill();
  rect(cx - 148, cy - 26, 296, 52, 2);
  fill(...PAL.ink);
  textSize(12);
  textAlign(CENTER, CENTER);
  text("[ CLICK_CANVAS :: INIT_AUDIO_STREAM ]", cx, cy);
  textAlign(LEFT, BASELINE);
}

function drawHandThin(hand) {
  stroke(...PAL.ink, 55);
  strokeWeight(0.55);
  noFill();
  for (let j = 0; j < hand.keypoints.length; j++) {
    let p = hand.keypoints[j];
    ellipse(p.x, p.y, 7, 7);
  }
}

function drawPinchConstruct(thumb, indexFinger, radius) {
  let cx = (thumb.x + indexFinger.x) / 2;
  let cy = (thumb.y + indexFinger.y) / 2;

  stroke(...PAL.ink);
  strokeWeight(0.65);
  line(thumb.x, thumb.y, indexFinger.x, indexFinger.y);

  drawingContext.setLineDash([5, 6]);
  noFill();
  ellipse(cx, cy, radius, radius);
  drawingContext.setLineDash([]);

  stroke(...PAL.ink, 70);
  strokeWeight(0.5);
  drawCircleWithX(cx, cy, 5);

  fill(...PAL.ink);
  noStroke();
  ellipse(cx, cy, 2.2, 2.2);
}

function drawCircleWithX(x, y, r) {
  noFill();
  ellipse(x, y, r * 2, r * 2);
  line(x - r * 0.65, y - r * 0.65, x + r * 0.65, y + r * 0.65);
  line(x - r * 0.65, y + r * 0.65, x + r * 0.65, y - r * 0.65);
}

function drawDataHUD(thumb, indexFinger, radius, playbackRate, volume) {
  let cx = (thumb.x + indexFinger.x) / 2;
  let cy = (thumb.y + indexFinger.y) / 2;

  stroke(...PAL.ink, 40);
  strokeWeight(0.5);
  noFill();
  line(width / 2, height / 2, cx, cy);

  textSize(10);
  fill(...PAL.ink);
  noStroke();
  text(`POS X: ${nf(cx, 1, 0)}  Y: ${nf(cy, 1, 0)}`, cx + 12, cy - 6);
  text(`[ PINCH_R: ${nf(radius, 1, 1)} ]`, cx + 12, cy + 8);
  text(`RATE // VOL  ${nf(playbackRate, 1, 2)}  ·  ${nf(volume, 1, 2)}`, 14, height - 38);

  noFill();
  stroke(...PAL.ink, 55);
  strokeWeight(0.55);
  rect(10, 52, 280, 74, 2);

  textSize(10);
  fill(...PAL.ink);
  text("// TRACE · GESTURE_SAMPLE_CONTROLLER", 18, 70);
  text(`RADIUS        ${nf(radius, 1, 1)} px`, 18, 88);
  text(`RATE_PITCH    ${nf(playbackRate, 1, 2)}  (sample.rate)`, 18, 104);
  text(`AMPLITUDE     ${nf(volume, 1, 2)}`, 18, 120);
}

function drawSignalNull() {
  textSize(10);
  fill(...PAL.inkFaint);
  noStroke();
  text("// SIGNAL: NULL · NO_HAND", 14, height - 18);
}

function gotHands(results) {
  hands = results;
}

function mousePressed() {
  if (!soundStarted) {
    userStartAudio();
    sample.loop();
    sample.amp(0.5);
    soundStarted = true;
    console.log("Audio started");
  }
}
