let handPose;
let video;
let hands = [];

let sample;
let soundStarted = false;

let filter;

let options = {
  maxHands: 2,
  flipped: false,
  runtime: "mediapipe",
  modelType: "full",
  detectorModelUrl: undefined,
  landmarkModelUrl: undefined,
};

function preload() {
  // Load hand pose model
  handPose = ml5.handPose(options, modelReady);

  // Load your wav sample
  sample = loadSound("sample.wav");
}

function modelReady() {
  console.log("HandPose Model Loaded!");
}

function setup() {
  createCanvas(640, 480);

  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();

  handPose.detectStart(video, gotHands);

  // Create a low-pass filter
  filter = new p5.LowPass();

  // Route sample through the filter
  sample.disconnect();
  sample.connect(filter);

  // Initial sound settings
  sample.amp(0);
  sample.rate(1);
  sample.pan(0);
}

function draw() {
  image(video, 0, 0, width, height);

  // Default values when no hands
  let volume = 0;
  let playbackRate = 1;
  let panValue = 0;
  let filterFreq = 1000;

  if (hands.length > 0) {
    for (let i = 0; i < hands.length; i++) {
      let hand = hands[i];

      drawHandPoints(hand);

      let thumb = hand.keypoints[4];
      let indexFinger = hand.keypoints[8];
      let wrist = hand.keypoints[0];

      let pinchDistance = dist(
        thumb.x,
        thumb.y,
        indexFinger.x,
        indexFinger.y
      );

      // Visual circle between thumb and index finger
      noFill();
      stroke(255);
      strokeWeight(2);
      ellipse(
        (thumb.x + indexFinger.x) / 2,
        (thumb.y + indexFinger.y) / 2,
        pinchDistance
      );

      let isLeftSide = wrist.x < width / 2;

      if (isLeftSide) {
        // LEFT HAND:
        // Pinch distance controls volume
        volume = map(pinchDistance, 20, 220, 0, 1);
        volume = constrain(volume, 0, 1);

        // Hand height controls low-pass filter
        // Hand up = brighter sound
        // Hand down = darker sound
        filterFreq = map(wrist.y, height, 0, 200, 8000);
        filterFreq = constrain(filterFreq, 200, 8000);
      } else {
        // RIGHT HAND:
        // Hand height controls playback speed
        // Hand up = faster
        // Hand down = slower
        playbackRate = map(wrist.y, height, 0, 0.5, 2.0);
        playbackRate = constrain(playbackRate, 0.5, 2.0);

        // Hand x controls stereo pan
        panValue = map(wrist.x, 0, width, -1, 1);
        panValue = constrain(panValue, -1, 1);
      }

      // Draw control text
      fill(255);
      noStroke();
      textSize(14);
      text(`pinch: ${nf(pinchDistance, 1, 1)}`, wrist.x + 10, wrist.y);
    }

    if (soundStarted) {
      sample.amp(volume, 0.1);
      sample.rate(playbackRate);
      sample.pan(panValue);
      filter.freq(filterFreq);
      filter.res(5);
    }
  } else {
    // No hands = fade out
    if (soundStarted) {
      sample.amp(0, 0.2);
    }
  }

  drawUI(volume, playbackRate, panValue, filterFreq);
}

function drawHandPoints(hand) {
  for (let j = 0; j < hand.keypoints.length; j++) {
    let keypoint = hand.keypoints[j];
    fill(0, 255, 0);
    noStroke();
    circle(keypoint.x, keypoint.y, 8);
  }
}

function drawUI(volume, playbackRate, panValue, filterFreq) {
  fill(0, 180);
  noStroke();
  rect(10, 10, 240, 110, 10);

  fill(255);
  textSize(14);
  text(`Volume: ${nf(volume, 1, 2)}`, 25, 35);
  text(`Rate: ${nf(playbackRate, 1, 2)}`, 25, 55);
  text(`Pan: ${nf(panValue, 1, 2)}`, 25, 75);
  text(`Filter: ${nf(filterFreq, 1, 0)} Hz`, 25, 95);
}

function gotHands(results) {
  hands = results;
}

function mousePressed() {
  if (!soundStarted) {
    userStartAudio();

    // Loop the wav sample
    sample.loop();

    // Start silent, then hand gestures control it
    sample.amp(0);

    soundStarted = true;
    console.log("Sample started");
  }
}