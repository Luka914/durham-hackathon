const seedBuilding = {
  id: "palatine-centre",
  name: "Palatine Centre",
  start: "entrance",
  nodes: [
    { id:"entrance", name:"Main Entrance", type:"entrance", x:86, y:207, labels:["main entrance"], links:[{to:"hall", meters:40}] },
    { id:"hall", name:"Central Hall", type:"junction", x:280, y:207, labels:["central hall"], links:[{to:"entrance", meters:40},{to:"junction", meters:35},{to:"toilet", meters:20},{to:"lift", meters:18}] },
    { id:"junction", name:"East Corridor", type:"junction", x:450, y:207, labels:["east corridor"], links:[{to:"hall", meters:35},{to:"theatre", meters:25},{to:"services", meters:30},{to:"lab", meters:35},{to:"lift", meters:45}] },
    { id:"theatre", name:"Lecture Theatre 1", type:"room", x:594, y:92, labels:["lecture theatre"], links:[{to:"junction", meters:25}] },
    { id:"services", name:"Student Services", type:"room", x:594, y:207, labels:["student services"], links:[{to:"junction", meters:30}] },
    { id:"lab", name:"Computer Lab 2", type:"room", x:594, y:322, labels:["computer lab"], links:[{to:"junction", meters:35}] },
    { id:"toilet", name:"Accessible Toilet", type:"room", x:280, y:322, labels:["accessible toilet"], links:[{to:"hall", meters:20}] },
    { id:"lift", name:"Lift", type:"lift", x:280, y:92, labels:["lift"], links:[{to:"hall", meters:18},{to:"junction", meters:45}] }
  ]
};
const mathsBuilding = {
  id:"maths-computer-science",
  name:"Maths & Computer Science Building",
  start:"mcs-demo-entrance",
  location:null,
  nodes:[
    { id:"mcs-demo-entrance", name:"Demo entrance", type:"entrance", x:86, y:207, labels:["demo entrance"], links:[{to:"mcs-demo-corridor",meters:15}], demo:true },
    { id:"mcs-demo-corridor", name:"Demo corridor", type:"junction", x:310, y:207, labels:["demo corridor"], links:[{to:"mcs-demo-entrance",meters:15},{to:"mcs-demo-room",meters:15}], demo:true },
    { id:"mcs-demo-room", name:"Demo teaching room", type:"room", x:570, y:207, labels:["demo teaching room"], links:[{to:"mcs-demo-corridor",meters:15}], demo:true }
  ]
};

const $ = id => document.getElementById(id);
const DB_NAME = "roomroute-media";
let legacyLabelsNeedCleanup = localStorage.getItem("roomroute-label-privacy-cleanup") !== "complete";
let buildings = loadBuildings();
let activeBuildingId = localStorage.getItem("roomroute-active-building") || mathsBuilding.id;
if (localStorage.getItem("roomroute-mcs-pilot-defaulted") !== "true") activeBuildingId = mathsBuilding.id;
let currentLocationId = getBuilding().start || getBuilding().nodes[0]?.id || "";
let stream = null;
let scanBusy = false;
let scanTimer = null;
let ocrWorkerPromise = null;
let placementMode = false;
let pendingLabels = [];
let pendingWalkthroughStops = [];
let pendingSignLabelCandidates = [];
let toastTimer;
const destination = $("destination");

function loadBuildings() {
  try {
    const saved = JSON.parse(localStorage.getItem("roomroute-buildings") || "null");
    const initial = Array.isArray(saved) && saved.length ? saved : [JSON.parse(JSON.stringify(seedBuilding))];
    const savedMathsBuilding = initial.find(building => building.id === mathsBuilding.id);
    if (!savedMathsBuilding) initial.push(JSON.parse(JSON.stringify(mathsBuilding)));
    else if (!savedMathsBuilding.nodes.length) {
      savedMathsBuilding.start = mathsBuilding.start;
      savedMathsBuilding.nodes = JSON.parse(JSON.stringify(mathsBuilding.nodes));
    }
    if (legacyLabelsNeedCleanup) {
      for (const building of initial) {
        for (const node of building.nodes || []) {
          node.labels = [typeof node.name === "string" ? node.name.toLowerCase() : ""].filter(Boolean);
        }
      }
    }
    return initial;
  } catch (error) {
    console.error("Could not read saved building maps", error);
    return [JSON.parse(JSON.stringify(seedBuilding))];
  }
}

function renderSignStopOptions() {
  const select = $("signStopSelect");
  const previous = select.value;
  select.replaceChildren();
  for (const node of getBuilding().nodes) {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = node.name;
    select.append(option);
  }
  if (getBuilding().nodes.some(node => node.id === previous)) select.value = previous;
}

function getBuilding() {
  return buildings.find(building => building.id === activeBuildingId) || buildings[0];
}

function findNode(id) {
  return getBuilding().nodes.find(node => node.id === id);
}

function saveBuildings() {
  localStorage.setItem("roomroute-buildings", JSON.stringify(buildings));
  localStorage.setItem("roomroute-active-building", activeBuildingId);
}

function svgEl(name, attrs, text) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, value);
  if (text) el.textContent = text;
  return el;
}

function calculateRoute(targetId) {
  const nodes = getBuilding().nodes;
  if (!findNode(currentLocationId) || !findNode(targetId)) return { path:[], distance:0 };
  const distances = Object.fromEntries(nodes.map(node => [node.id, Infinity]));
  const previous = {};
  const unvisited = new Set(nodes.map(node => node.id));
  distances[currentLocationId] = 0;
  while (unvisited.size) {
    let nearest = null;
    for (const id of unvisited) {
      if (nearest === null || distances[id] < distances[nearest]) nearest = id;
    }
    if (nearest === null || distances[nearest] === Infinity || nearest === targetId) break;
    unvisited.delete(nearest);
    for (const edge of (findNode(nearest)?.links || [])) {
      if (!unvisited.has(edge.to)) continue;
      const distance = distances[nearest] + edge.meters;
      if (distance < distances[edge.to]) {
        distances[edge.to] = distance;
        previous[edge.to] = nearest;
      }
    }
  }
  const path = [];
  let step = targetId;
  while (step) {
    path.unshift(step);
    if (step === currentLocationId) break;
    step = previous[step];
  }
  return path[0] === currentLocationId ? { path, distance:distances[targetId] } : { path:[], distance:0 };
}

function selectedDestination() {
  return destination.value || getBuilding().nodes.find(node => node.id !== currentLocationId)?.id || "";
}

function drawMap(routePath = []) {
  const svg = $("map");
  const building = getBuilding();
  svg.replaceChildren();
  const group = svgEl("g", { "font-family":"Inter, system-ui, sans-serif" });
  svg.append(group);
  const drawnEdges = new Set();

  for (const node of building.nodes) {
    for (const edge of node.links || []) {
      const key = [node.id, edge.to].sort().join(":");
      if (drawnEdges.has(key)) continue;
      drawnEdges.add(key);
      const neighbor = building.nodes.find(item => item.id === edge.to);
      if (!neighbor) continue;
      const onRoute = routePath.includes(node.id) && routePath.includes(neighbor.id) &&
        Math.abs(routePath.indexOf(node.id) - routePath.indexOf(neighbor.id)) === 1;
      group.append(svgEl("line", {
        x1:node.x, y1:node.y, x2:neighbor.x, y2:neighbor.y,
        stroke:onRoute ? "#176c56" : "#d2dbd3",
        "stroke-width":onRoute ? 5 : 3,
        "stroke-linecap":"round",
        class:onRoute ? "route-animate" : ""
      }));
    }
  }

  for (const node of building.nodes) {
    const isCurrent = node.id === currentLocationId;
    const isDestination = node.id === destination.value;
    const fill = isCurrent ? "#176c56" : isDestination ? "#f2a75a" : "#fff";
    group.append(svgEl("circle", {
      cx:node.x, cy:node.y, r:isCurrent || isDestination ? 13 : 10,
      fill, stroke:isCurrent || isDestination ? "#fff" : "#819087", "stroke-width":2
    }));
    if (isCurrent) group.append(svgEl("circle", { cx:node.x, cy:node.y, r:18, fill:"none", stroke:"#176c56", "stroke-width":1.5, opacity:.45 }));
    group.append(svgEl("text", {
      x:node.x, y:node.y+29, "text-anchor":"middle", fill:"#53645b",
      "font-size":Math.max(8, 11 - (node.name.length > 18 ? 2 : 0)), "font-weight":700
    }, node.name));
  }
  svg.setAttribute("aria-label", `${building.name} route map. Current location: ${findNode(currentLocationId)?.name || "not set"}.`);
  svg.style.cursor = placementMode ? "crosshair" : "default";
  $("buildingTitle").textContent = building.name;
  $("mapSubtitle").textContent = placementMode
    ? "Click the map to place this location"
    : building.nodes.some(node => node.demo)
      ? "Example route only · verify building locations on site"
      : building.nodes.some(node => node.routeEstimate)
        ? `${building.nodes.length} mapped locations · walkthrough route is estimated`
      : `${building.nodes.length} mapped locations · routes use uploaded building data`;
}

function renderBuildingOptions() {
  const buildingSelect = $("buildingSelect");
  buildingSelect.replaceChildren();
  for (const building of buildings) {
    const option = document.createElement("option");
    option.value = building.id;
    option.textContent = building.name;
    option.selected = building.id === activeBuildingId;
    buildingSelect.append(option);
  }
  const nodes = getBuilding().nodes;
  const previouslySelected = destination.value;
  const selected = nodes.some(node => node.id === previouslySelected && node.id !== currentLocationId)
    ? previouslySelected
    : nodes.find(node => node.id !== currentLocationId && node.type === "room")?.id ||
      nodes.find(node => node.id !== currentLocationId)?.id || "";
  destination.replaceChildren();
  for (const node of nodes.filter(item => item.id !== currentLocationId)) {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = node.name;
    option.selected = node.id === selected;
    destination.append(option);
  }
  renderConnectOptions();
  renderSignStopOptions();
}

function renderConnectOptions() {
  const select = $("connectFrom");
  const previous = select.value;
  select.replaceChildren();
  for (const node of getBuilding().nodes) {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = node.name;
    select.append(option);
  }
  if (getBuilding().nodes.some(node => node.id === previous)) select.value = previous;
  else if (getBuilding().nodes.some(node => node.id === currentLocationId)) select.value = currentLocationId;
}

function updateRoute() {
  const targetId = selectedDestination();
  const target = findNode(targetId);
  const route = calculateRoute(targetId);
  const estimatedRoute = route.path.some(id => {
    const node = findNode(id);
    return node?.demo || node?.routeEstimate;
  });
  $("routeDestination").textContent = target?.name || "Add locations in Building admin";
  $("routeTime").textContent = !target ? "No route yet" :
    route.path.length < 2 ? "Choose a destination" :
    `${estimatedRoute ? "~" : ""}${Math.max(1, Math.ceil(route.distance / 50))} min · ${estimatedRoute ? "~" : ""}${route.distance} m`;
  $("routeSummary").textContent = !target
    ? "Build a map with at least two connected locations."
    : route.path.length < 2
      ? `Current location · ${findNode(currentLocationId)?.name || "not set"}`
      : `From ${findNode(currentLocationId)?.name || "current location"} · via ${route.path.slice(1, -1).map(id => findNode(id)?.name).join(", ") || "direct route"}${estimatedRoute ? " · estimated route" : ""}`;

  const steps = $("steps");
  steps.replaceChildren();
  const nextLocations = route.path.slice(1);
  if (!target || !nextLocations.length) {
    const row = document.createElement("div");
    row.className = "step";
    const icon = document.createElement("span");
    icon.className = "step-icon";
    icon.textContent = target ? "✓" : "＋";
    const copy = document.createElement("div");
    copy.className = "step-copy";
    copy.textContent = target ? "You’re at this location." : "Add at least two connected locations.";
    row.append(icon, copy);
    steps.append(row);
  }
  nextLocations.slice(0, 4).forEach((id, index) => {
    const node = findNode(id);
    const row = document.createElement("div");
    row.className = "step";
    const icon = document.createElement("span");
    icon.className = "step-icon";
    icon.textContent = index === 0 ? "↑" : "→";
    const copy = document.createElement("div");
    copy.className = "step-copy";
    copy.textContent = node.type === "room" ? `Continue to ${node.name}` : `Continue via ${node.name}`;
    const small = document.createElement("small");
    small.textContent = index === nextLocations.length - 1 ? "Destination" : "Next landmark";
    copy.append(small);
    row.append(icon, copy);
    steps.append(row);
  });
  drawMap(route.path);
}

function announce(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2600);
}

function setCurrentLocation(id) {
  if (!findNode(id)) return;
  currentLocationId = id;
  $("cameraStatus").textContent = `Landmark matched: ${findNode(id).name}. Route updated.`;
  renderBuildingOptions();
  updateRoute();
  announce(`Position updated · ${findNode(id).name}`);
}

function matchLandmarkText(text) {
  const normalizedText = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const wordsInScan = new Set(normalizedText.split(/\s+/));
  const genericWords = new Set(["room", "hall", "the", "lab", "main", "floor", "level", "building", "area"]);
  const matches = getBuilding().nodes.map(node => {
    const score = [node.name, ...(node.labels || [])].reduce((best, phrase) => {
      const normalized = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      const words = normalized.split(" ").filter(word => word.length >= 4 && !genericWords.has(word));
      const partial = words.filter(word => wordsInScan.has(word)).length * 10;
      return Math.max(best, (normalized && normalizedText.includes(normalized) ? 100 + normalized.length : 0) + partial);
    }, 0);
    return { node, score };
  }).filter(match => match.score >= 30).sort((a,b) => b.score - a.score);
  if (!matches.length || (matches.length > 1 && matches[0].score === matches[1].score)) return null;
  return matches[0].node;
}

function renderAdminLocations() {
  const list = $("locationsList");
  list.replaceChildren();
  for (const node of getBuilding().nodes) {
    const row = document.createElement("div");
    row.className = "location-row";
    const label = document.createElement("span");
    label.textContent = node.name;
    const meta = document.createElement("span");
    meta.className = "location-meta";
    meta.textContent = `${node.type} · ${node.labels?.length || 0} camera labels`;
    row.append(label, meta);
    if (node.id !== getBuilding().start) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-location";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeLocation(node.id));
      row.append(remove);
    }
    list.append(row);
  }
  if (!getBuilding().nodes.length) list.textContent = "No locations added yet.";
}

function showAdmin() {
  renderAdminLocations();
  renderConnectOptions();
  $("adminDialog").showModal();
}

function openMediaDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("roomroute-media", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("references");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local media storage."));
  });
}

async function clearLegacyReferenceMedia() {
  if (localStorage.getItem("roomroute-private-media-cleanup") === "complete") return;
  const db = await openMediaDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("references", "readwrite");
    transaction.objectStore("references").clear();
    transaction.oncomplete = () => {
      db.close();
      localStorage.setItem("roomroute-private-media-cleanup", "complete");
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not remove previously saved uploads."));
    };
  });
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    if (file.type.startsWith("image/")) {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d").drawImage(image, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read the uploaded image.")); };
      image.src = url;
      return;
    }
    if (!file.type.startsWith("video/")) {
      URL.revokeObjectURL(url);
      reject(new Error("Choose an image or video file."));
      return;
    }
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    const releaseVideo = () => {
      video.onloadeddata = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    video.onloadeddata = () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      releaseVideo();
      resolve(canvas);
    };
    video.onerror = () => { releaseVideo(); reject(new Error("Could not read the uploaded video.")); };
    video.src = url;
  });
}

function readVideoFrames(file, reportProgress) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    const releaseVideo = () => {
      video.onloadeddata = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    video.onloadeddata = async () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        releaseVideo();
        reject(new Error("Could not read the video duration."));
        return;
      }
      const frameCount = 5;
      const duration = Math.max(0, video.duration - 0.1);
      const times = [...new Set(Array.from({ length:frameCount }, (_, index) =>
        duration * index / (frameCount - 1)
      ))];
      const labels = [];
      try {
        for (let index = 0; index < times.length; index++) {
          reportProgress(`Reading video frame ${index + 1} of ${times.length}…`);
          if (Math.abs(video.currentTime - times[index]) > 0.02) {
            await new Promise((resolveSeek, rejectSeek) => {
              video.addEventListener("seeked", resolveSeek, { once:true });
              video.addEventListener("error", () => rejectSeek(new Error("Could not read a video frame.")), { once:true });
              video.currentTime = times[index];
            });
          }
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext("2d").drawImage(video, 0, 0);
          const text = await readLandmarkText(canvas);
          if (text && !labels.includes(text)) labels.push(text);
        }
        releaseVideo();
        resolve(labels);
      } catch (error) {
        releaseVideo();
        reject(error);
      }
    };
    video.onerror = () => {
      releaseVideo();
      reject(new Error("Could not open the uploaded video."));
    };
    video.src = url;
  });
}

function readVideoStops(file, reportProgress) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    const releaseVideo = () => {
      video.onloadeddata = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    video.onloadeddata = async () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        releaseVideo();
        reject(new Error("Could not read the video duration."));
        return;
      }
      const frameCount = 8;
      const duration = Math.max(0, video.duration - 0.1);
      const stops = [];
      const byName = new Map();
      try {
        for (let index = 0; index < frameCount; index++) {
          const time = duration * index / (frameCount - 1);
          reportProgress(`Finding readable signs · frame ${index + 1} of ${frameCount}…`);
          if (Math.abs(video.currentTime - time) > 0.02) {
            await new Promise((resolveSeek, rejectSeek) => {
              const onSeeked = () => resolveSeek();
              const onError = () => rejectSeek(new Error("Could not read a video frame."));
              video.addEventListener("seeked", onSeeked, { once:true });
              video.addEventListener("error", onError, { once:true });
              video.currentTime = time;
            });
          }
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext("2d").drawImage(video, 0, 0);
          const evidence = await readOcrEvidence(canvas);
          const matched = evidence.lines
            .filter(line => line.confidence >= 30)
            .map(line => ({ line, node:matchLandmarkText(line.text) }))
            .filter(match => match.node)
            .sort((a, b) => b.line.confidence - a.line.confidence)[0]?.node;
          if (matched) {
            const key = `mapped:${matched.id}`;
            if (!byName.has(key)) {
              const stop = { name:matched.name, nodeId:matched.id };
              byName.set(key, stop);
              stops.push(stop);
            }
            continue;
          }
          const candidate = evidence.lines
            .filter(line => line.confidence >= 35)
            .map(line => line.text.replace(/[^a-zA-Z0-9 &.'#/-]/g, " ").replace(/\s+/g, " ").trim())
            .filter(line => line.length >= 3 && (line.match(/[a-zA-Z]/g) || []).length >= 2)
            .sort((a, b) => b.length - a.length)[0];
          if (!candidate) continue;
          const key = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (!key) continue;
          const existing = byName.get(key);
          if (existing) continue;
          const stop = { name:candidate };
          byName.set(key, stop);
          stops.push(stop);
        }
        releaseVideo();
        resolve(stops);
      } catch (error) {
        releaseVideo();
        reject(error);
      }
    };
    video.onerror = () => {
      releaseVideo();
      reject(new Error("Could not open the uploaded video."));
    };
    video.src = url;
  });
}

async function readOcrEvidence(image) {
  try {
    if (!window.Tesseract) throw new Error("Neural OCR is still loading. Wait a moment and try again.");
    if (!ocrWorkerPromise) ocrWorkerPromise = Tesseract.createWorker("eng");
    const worker = await ocrWorkerPromise;
    const { data } = await worker.recognize(image);
    return {
      text:data.text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(),
      lines:(data.lines || []).map(line => ({
        text:line.text || "",
        confidence:Number(line.confidence) || 0
      }))
    };
  } finally {
    if (image instanceof HTMLCanvasElement) {
      image.width = 0;
      image.height = 0;
    }
  }
}

function renderWalkthroughDraft() {
  const preview = $("walkthroughPreview");
  preview.replaceChildren();
  $("addWalkthroughStops").disabled = !pendingWalkthroughStops.length;
  if (!pendingWalkthroughStops.length) return;
  for (const [index, stop] of pendingWalkthroughStops.entries()) {
    const item = document.createElement("li");
    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 60;
    name.value = stop.name;
    name.setAttribute("aria-label", `Review detected stop ${index + 1}`);
    name.dataset.stopIndex = index;
    if (stop.nodeId) name.dataset.nodeId = stop.nodeId;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-location";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove detected stop ${index + 1}`);
    remove.addEventListener("click", () => {
      [...preview.querySelectorAll("input")].forEach((input, stopIndex) => {
        if (pendingWalkthroughStops[stopIndex]) {
          pendingWalkthroughStops[stopIndex].name = input.value;
        }
      });
      pendingWalkthroughStops.splice(index, 1);
      renderWalkthroughDraft();
    });
    item.append(name, remove);
    preview.append(item);
  }
}

function renderSignLabelCandidates() {
  const list = $("signLabelCandidates");
  list.replaceChildren();
  for (const [index, candidate] of pendingSignLabelCandidates.entries()) {
    const label = document.createElement("label");
    label.className = "sign-label-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = candidate.text;
    checkbox.id = `sign-label-${index}`;
    const copy = document.createElement("span");
    const text = document.createElement("strong");
    text.textContent = candidate.text;
    const evidence = document.createElement("small");
    const confidence = candidate.confidence >= 75 ? "Clear read" : candidate.confidence >= 50 ? "Possible read" : "Low-confidence read";
    evidence.textContent = `${confidence}${candidate.photos > 1 ? ` · seen in ${candidate.photos} photos` : ""}`;
    copy.append(text, evidence);
    label.append(checkbox, copy);
    list.append(label);
  }
  updateSignLabelSaveButton();
}

function updateSignLabelSaveButton() {
  const hasSelectedSuggestion = $("signLabelCandidates").querySelector("input:checked");
  const hasManualLabel = $("signLabelManual").value.trim();
  $("saveSignLabels").disabled = !hasSelectedSuggestion && !hasManualLabel;
}

function createSignOcrVariants(image) {
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  if (!width || !height) throw new Error("The selected photo has no readable image dimensions.");
  const scale = Math.min(2, Math.max(1, 1200 / Math.min(width, height)), 2200 / Math.max(width, height));
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const source = document.createElement("canvas");
  source.width = outputWidth;
  source.height = outputHeight;
  const sourceContext = source.getContext("2d", { willReadFrequently:true });
  sourceContext.drawImage(image, 0, 0, outputWidth, outputHeight);
  const pixels = sourceContext.getImageData(0, 0, outputWidth, outputHeight);
  const gray = new Uint8Array(outputWidth * outputHeight);
  const histogram = new Uint32Array(256);
  for (let index = 0; index < gray.length; index++) {
    const offset = index * 4;
    const value = Math.round(pixels.data[offset] * .299 + pixels.data[offset + 1] * .587 + pixels.data[offset + 2] * .114);
    gray[index] = value;
    histogram[value]++;
  }
  let sum = 0;
  for (let value = 0; value < histogram.length; value++) sum += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let threshold = 127;
  let maxVariance = 0;
  for (let value = 0; value < histogram.length; value++) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = gray.length - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = value;
    }
  }
  const grayscale = document.createElement("canvas");
  grayscale.width = outputWidth;
  grayscale.height = outputHeight;
  const grayContext = grayscale.getContext("2d");
  const grayPixels = grayContext.createImageData(outputWidth, outputHeight);
  const binary = document.createElement("canvas");
  binary.width = outputWidth;
  binary.height = outputHeight;
  const binaryContext = binary.getContext("2d");
  const binaryPixels = binaryContext.createImageData(outputWidth, outputHeight);
  for (let index = 0; index < gray.length; index++) {
    const value = gray[index];
    const contrast = Math.max(0, Math.min(255, Math.round((value - 128) * 1.35 + 128)));
    const offset = index * 4;
    grayPixels.data[offset] = contrast;
    grayPixels.data[offset + 1] = contrast;
    grayPixels.data[offset + 2] = contrast;
    grayPixels.data[offset + 3] = 255;
    const binaryValue = value > threshold ? 255 : 0;
    binaryPixels.data[offset] = binaryValue;
    binaryPixels.data[offset + 1] = binaryValue;
    binaryPixels.data[offset + 2] = binaryValue;
    binaryPixels.data[offset + 3] = 255;
  }
  grayContext.putImageData(grayPixels, 0, 0);
  binaryContext.putImageData(binaryPixels, 0, 0);
  source.width = 0;
  source.height = 0;
  return [grayscale, binary];
}

async function recognizeSignPhotos(files, reportProgress) {
  const candidates = new Map();
  for (const [index, file] of files.entries()) {
    if (!file.type.startsWith("image/")) continue;
    reportProgress(`Enhancing sign photo ${index + 1} of ${files.length} locally…`);
    const image = await readImage(file);
    let variants = [];
    try {
      variants = createSignOcrVariants(image);
    } finally {
      image.width = 0;
      image.height = 0;
    }
    try {
      for (const [variantIndex, variant] of variants.entries()) {
        reportProgress(`Reading sign photo ${index + 1} of ${files.length} · enhancement ${variantIndex + 1} of ${variants.length}…`);
        const evidence = await readOcrEvidence(variant);
        for (const line of evidence.lines) {
          const text = line.text.replace(/[^a-zA-Z0-9 &.'#/-]/g, " ").replace(/\s+/g, " ").trim();
          if (line.confidence < 20 || text.length < 2 || text.length > 80 ||
              (text.match(/[a-zA-Z]/g) || []).length < 2) continue;
          const key = text.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (!key) continue;
          const existing = candidates.get(key);
          if (existing) {
            existing.confidence = Math.max(existing.confidence, line.confidence);
            existing.photos.add(index);
          } else {
            candidates.set(key, { text, confidence:line.confidence, photos:new Set([index]) });
          }
        }
      }
    } finally {
      for (const variant of variants) {
        if (variant.width || variant.height) {
          variant.width = 0;
          variant.height = 0;
        }
      }
    }
  }
  return [...candidates.values()]
    .map(candidate => ({ ...candidate, photos:candidate.photos.size }))
    .sort((a, b) => b.confidence - a.confidence || b.photos - a.photos)
    .slice(0, 30);
}

function saveSignLabels() {
  const node = findNode($("signStopSelect").value);
  if (!node) {
    $("signLabelStatus").textContent = "Choose a mapped stop first.";
    return;
  }
  const selected = [...$("signLabelCandidates").querySelectorAll("input:checked")]
    .map(input => input.value);
  const manual = $("signLabelManual").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const aliases = [...new Set([...selected, ...manual])]
    .map(value => value.slice(0, 80))
    .filter(value => value.toLowerCase() !== node.name.toLowerCase());
  if (!aliases.length) {
    $("signLabelStatus").textContent = "Select a sign-text suggestion or type a short sign label to teach this stop.";
    return;
  }
  const previousLabels = node.labels;
  node.labels = [...new Set([node.name.toLowerCase(), ...(node.labels || []), ...aliases])].slice(0, 31);
  try {
    saveBuildings();
  } catch (error) {
    node.labels = previousLabels;
    $("signLabelStatus").textContent = `Could not save sign labels: ${error.message}`;
    return;
  }
  $("signLabelPhotos").value = "";
  $("signLabelManual").value = "";
  pendingSignLabelCandidates = [];
  renderSignLabelCandidates();
  $("signLabelStatus").textContent = `Saved ${aliases.length} reviewed sign label${aliases.length === 1 ? "" : "s"} for ${node.name}. Photos and unselected OCR text were discarded.`;
  renderAdminLocations();
}

function addWalkthroughStops() {
  if (!pendingWalkthroughStops.length) return;
  const reviewedStops = [...$("walkthroughPreview").querySelectorAll("input")].map(input => ({
    name:input.value.trim(),
    ...(input.dataset.nodeId ? { nodeId:input.dataset.nodeId } : {})
  }));
  if (!reviewedStops.length || reviewedStops.some(stop => !stop.name)) {
    $("walkthroughStatus").textContent = "Give each kept stop a room or landmark name, or remove it before saving.";
    return;
  }
  const building = getBuilding();
  const originalNodes = JSON.parse(JSON.stringify(building.nodes));
  const originalStart = building.start;
  const originalLocation = currentLocationId;
  const hasMappedMatches = reviewedStops.some(stop =>
    stop.nodeId && building.nodes.some(node => node.id === stop.nodeId)
  );
  const replaceDemo = !hasMappedMatches && building.nodes.length > 0 && building.nodes.every(node => node.demo);
  if (replaceDemo) {
    building.nodes = [];
    building.start = null;
  }
  let parent = building.nodes[building.nodes.length - 1] || null;
  const stops = reviewedStops;
  for (const [index, stop] of stops.entries()) {
    const knownNode = !replaceDemo && stop.nodeId
      ? building.nodes.find(node => node.id === stop.nodeId)
      : null;
    if (knownNode) {
      if (parent && parent.id !== knownNode.id &&
          !parent.links.some(edge => edge.to === knownNode.id)) {
        parent.links.push({ to:knownNode.id, meters:15 });
        knownNode.links.push({ to:parent.id, meters:15 });
      }
      parent = knownNode;
      continue;
    }
    const id = `location-${crypto.randomUUID()}`;
    const x = Math.round(replaceDemo
      ? (stops.length === 1 ? 350 : 86 + index * 508 / (stops.length - 1))
      : parent ? (parent.x > 620 ? 86 : parent.x + 170) : 350);
    const y = !replaceDemo && parent && x < parent.x
      ? (parent.y < 300 ? parent.y + 100 : parent.y - 100)
      : parent?.y || 207;
    const node = {
      id,
      name:stop.name,
      type:/entrance/i.test(stop.name) ? "entrance" : /lift|stairs/i.test(stop.name) ? "lift" : "room",
      x,
      y,
      labels:[stop.name.toLowerCase()],
      links:[],
      routeEstimate:true
    };
    if (stop.nodeId) node.recognizedMapNodeId = stop.nodeId;
    if (parent) {
      node.links.push({ to:parent.id, meters:15 });
      parent.links.push({ to:id, meters:15 });
    }
    building.nodes.push(node);
    parent = node;
  }
  if (!building.start && building.nodes.length) building.start = building.nodes[0].id;
  if (replaceDemo || !currentLocationId) currentLocationId = building.start;
  try {
    saveBuildings();
    localStorage.setItem("roomroute-mcs-pilot-defaulted", "true");
  } catch (error) {
    building.nodes = originalNodes;
    building.start = originalStart;
    currentLocationId = originalLocation;
    $("walkthroughStatus").textContent = `Could not save the route draft: ${error.message}`;
    return;
  }
  pendingWalkthroughStops = [];
  $("walkthroughVideo").value = "";
  $("walkthroughStatus").textContent = `Added ${stops.length} detected stop${stops.length === 1 ? "" : "s"} to ${building.name}. Route order follows the video; distances and map positions are estimates.`;
  renderWalkthroughDraft();
  renderBuildingOptions();
  renderAdminLocations();
  updateRoute();
  announce(`${stops.length} walkthrough stops added`);
}

async function readLandmarkText(image) {
  return (await readOcrEvidence(image)).text;
}

function closeCamera() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  $("camera").srcObject = null;
  $("camera").style.display = "none";
  $("cameraPlaceholder").style.display = "";
  $("cameraButton").hidden = false;
  $("scanButton").hidden = true;
  $("cameraOffButton").hidden = true;
  $("cameraStatus").textContent = "Camera off. Your last known location is saved.";
}

function printLandmarkCards() {
  const cards = $("printCardsContainer");
  cards.replaceChildren();
  const building = getBuilding();
  for (const node of building.nodes) {
    const card = document.createElement("div");
    card.className = "print-card";
    const buildingLabel = document.createElement("span");
    buildingLabel.textContent = `ROOMROUTE · ${building.name.toUpperCase()}`;
    const landmark = document.createElement("strong");
    landmark.textContent = node.name.toUpperCase();
    const note = document.createElement("small");
    note.textContent = node.demo ? "Example landmark · verify on site" :
      node.routeEstimate ? "Walkthrough landmark · verify on site" : "Mapped landmark";
    card.append(buildingLabel, landmark, note);
    cards.append(card);
  }
  window.print();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $("cameraStatus").textContent = "Camera needs HTTPS or localhost. Use Demo scan to try the prototype.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ ideal:"environment" } },
      audio:false
    });
    $("camera").srcObject = stream;
    $("camera").style.display = "block";
    $("cameraPlaceholder").style.display = "none";
    $("cameraButton").hidden = true;
    $("scanButton").hidden = false;
    $("cameraOffButton").hidden = false;
    $("cameraStatus").textContent = "Camera on. Looking for mapped sign text; use Scan landmark to check now.";
    scanTimer = setInterval(() => {
      if (stream && !scanBusy) scanCamera();
    }, 6000);
  } catch (error) {
    $("cameraStatus").textContent = error.name === "NotAllowedError"
      ? "Camera access was denied. Allow access or use Demo scan."
      : "Could not start the camera. Use Demo scan instead.";
  }
}

async function scanCamera() {
  if (!stream || scanBusy) return;
  scanBusy = true;
  $("scanButton").disabled = true;
  $("cameraStatus").textContent = "Neural OCR is reading nearby landmark text…";
  try {
    const video = $("camera");
    if (!video.videoWidth) throw new Error("Camera is not ready yet. Wait a moment and retry.");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d", { willReadFrequently:true }).drawImage(video, 0, 0);
    const text = await readLandmarkText(canvas);
    const match = matchLandmarkText(text);
    if (!match) {
      $("cameraStatus").textContent = "No mapped sign matched. Try better lighting or scan a location with a known sign.";
    } else {
      setCurrentLocation(match.id);
    }
  } catch (error) {
    $("cameraStatus").textContent = error.message;
  } finally {
    scanBusy = false;
    $("scanButton").disabled = false;
  }
}

function addBuilding(name) {
  const previousBuildingId = activeBuildingId;
  const previousLocationId = currentLocationId;
  const building = { id:`building-${crypto.randomUUID()}`, name, start:null, nodes:[] };
  buildings.push(building);
  activeBuildingId = building.id;
  currentLocationId = "";
  try {
    saveBuildings();
  } catch (error) {
    buildings.pop();
    activeBuildingId = previousBuildingId;
    currentLocationId = previousLocationId;
    $("cameraStatus").textContent = `Could not save this building: ${error.message}`;
    return;
  }
  renderBuildingOptions();
  renderAdminLocations();
  updateRoute();
  announce(`${name} added`);
}

async function addLocationAt(x, y) {
  const name = $("mapLocationName").value.trim();
  if (!name) {
    $("cameraStatus").textContent = "Enter a location name before placing it.";
    showAdmin();
    return;
  }
  const building = getBuilding();
  const parent = findNode($("connectFrom").value);
  const previousStart = building.start;
  const previousLocationId = currentLocationId;
  const id = `location-${crypto.randomUUID()}`;
  const meters = Number($("pathDistance").value);
  const node = {
    id, name, type:$("mapLocationType").value, x, y,
    labels:[name.toLowerCase()], links:[],
    ...( $("mapLocationName").dataset.osmId ? { osmId:$("mapLocationName").dataset.osmId } : {} )
  };
  if (parent) {
    node.links.push({ to:parent.id, meters });
    parent.links.push({ to:id, meters });
  } else {
    building.start = id;
  }
  building.nodes.push(node);
  if (!building.start) building.start = id;
  if (!currentLocationId) currentLocationId = building.start;
  try {
    saveBuildings();
  } catch (error) {
    building.nodes = building.nodes.filter(item => item.id !== id);
    if (parent) parent.links = parent.links.filter(edge => edge.to !== id);
    building.start = previousStart;
    currentLocationId = previousLocationId;
    $("cameraStatus").textContent = `Could not save this location: ${error.message}`;
    return;
  }
  pendingLabels = [];
  $("locationMedia").value = "";
  $("mediaStatus").textContent = "Reference media is processed locally and discarded; only recognised text labels are saved.";
  $("mapLocationName").value = "";
  delete $("mapLocationName").dataset.osmId;
  placementMode = false;
  renderBuildingOptions();
  renderAdminLocations();
  updateRoute();
  showAdmin();
  announce(`${name} added to the building map`);
}

function positionOnMap(latitude, longitude, center) {
  const pixelsPerDegree = 275000;
  const longitudeScale = Math.cos(center.latitude * Math.PI / 180);
  return {
    x:Math.round(Math.max(25, Math.min(675, 350 + (longitude - center.longitude) * pixelsPerDegree * longitudeScale))),
    y:Math.round(Math.max(25, Math.min(385, 207 - (latitude - center.latitude) * pixelsPerDegree)))
  };
}

function getElementPosition(element) {
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
    return { latitude:element.lat, longitude:element.lon };
  }
  if (element.center && Number.isFinite(element.center.lat) && Number.isFinite(element.center.lon)) {
    return { latitude:element.center.lat, longitude:element.center.lon };
  }
  if (Array.isArray(element.geometry) && element.geometry.length) {
    const points = element.geometry.filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    if (points.length) {
      return {
        latitude:points.reduce((sum, point) => sum + point.lat, 0) / points.length,
        longitude:points.reduce((sum, point) => sum + point.lon, 0) / points.length
      };
    }
  }
  return null;
}

async function importOpenStreetMapData() {
  const building = getBuilding();
  if (!building.location) {
    $("osmStatus").textContent = "Set this building’s GPS pin first, while you are there.";
    return;
  }
  const { latitude, longitude } = building.location;
  const radius = 120;
  const query = `[out:json][timeout:25];(node(around:${radius},${latitude},${longitude})[indoor];way(around:${radius},${latitude},${longitude})[indoor];relation(around:${radius},${latitude},${longitude})[indoor];node(around:${radius},${latitude},${longitude})[entrance];way(around:${radius},${latitude},${longitude})[highway~"footway|corridor"];);out center geom tags;`;
  $("importOsm").disabled = true;
  $("osmStatus").textContent = "Querying OpenStreetMap for mapped indoor features…";
  $("osmResults").replaceChildren();
  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8" },
      body:`data=${encodeURIComponent(query)}`
    });
    if (!response.ok) throw new Error(`OpenStreetMap query failed (${response.status}). Try again later.`);
    const result = await response.json();
    if (!Array.isArray(result.elements)) throw new Error("The public map service returned an unexpected response.");
    const existing = new Set(building.nodes.map(node =>
      `${node.name.toLowerCase()}|${node.osmId || ""}`
    ));
    const suggestions = result.elements.map(element => {
      const tags = element.tags || {};
      const position = getElementPosition(element);
      const name = tags.name || tags["room:number"] || tags.ref || tags.room || "";
      if (!position || !name) return null;
      const indoorType = (tags.indoor || tags.room || "").toLowerCase();
      const type = tags.entrance ? "entrance" :
        /room|classroom|office|lecture/.test(indoorType) ? "room" :
        /stairs|elevator|lift/.test(indoorType) ? "lift" : "junction";
      return {
        name:String(name).trim(),
        type,
        latitude:position.latitude,
        longitude:position.longitude,
        sourceId:`${element.type}/${element.id}`,
        detail:[tags.indoor, tags.level && `level ${tags.level}`, tags.entrance && "entrance"].filter(Boolean).join(" · ")
      };
    }).filter(item => item && item.name && !existing.has(`${item.name.toLowerCase()}|${item.sourceId}`));
    const unique = [...new Map(suggestions.map(item => [`${item.name.toLowerCase()}|${item.sourceId}`, item])).values()];
    if (!unique.length) {
      $("osmStatus").textContent = result.elements.length
        ? "No named indoor rooms or entrances were found nearby. OpenStreetMap coverage may be incomplete."
        : "No indoor map features are mapped near this GPS pin yet.";
      return;
    }
    $("osmStatus").textContent = `Found ${unique.length} public map suggestions. Select one to review, then choose its route connection.`;
    for (const suggestion of unique) {
      const row = document.createElement("div");
      row.className = "public-result";
      const label = document.createElement("span");
      label.append(document.createTextNode(suggestion.name));
      const detail = document.createElement("small");
      detail.textContent = `${suggestion.detail || suggestion.type} · OpenStreetMap ${suggestion.sourceId}`;
      label.append(detail);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Review";
      button.addEventListener("click", () => {
        const point = positionOnMap(suggestion.latitude, suggestion.longitude, building.location);
        $("mapLocationName").value = suggestion.name;
        $("mapLocationType").value = suggestion.type;
        $("mapLocationX").value = point.x;
        $("mapLocationY").value = point.y;
        $("pathDistance").value = "20";
        $("osmStatus").textContent = `${suggestion.name} selected. Check its map position and route connection before adding.`;
        $("mapLocationName").dataset.osmId = suggestion.sourceId;
      });
      row.append(label, button);
      $("osmResults").append(row);
    }
  } catch (error) {
    $("osmStatus").textContent = error.message || "Could not import public map data.";
  } finally {
    $("importOsm").disabled = false;
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location services are not available in this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      error => {
        const messages = {
          1:"Location permission was denied. Allow location access in your browser, then try again.",
          2:"Your location is unavailable. Check device location services and try again.",
          3:"Location request timed out. Move near a window or try again outdoors."
        };
        reject(new Error(messages[error.code] || "Could not get your location."));
      },
      { enableHighAccuracy:true, timeout:15000, maximumAge:10000 }
    );
  });
}

function distanceBetweenMeters(a, b) {
  const radians = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function saveBuildingGps(position) {
  const building = getBuilding();
  building.location = {
    latitude:position.coords.latitude,
    longitude:position.coords.longitude,
    accuracy:position.coords.accuracy,
    radius:Math.max(100, Math.min(300, position.coords.accuracy * 1.5)),
    capturedAt:new Date().toISOString()
  };
  if (!building.nodes.length) {
    const start = {
      id:`location-${crypto.randomUUID()}`,
      name:"GPS building start (approximate)",
      type:"entrance",
      x:350,
      y:207,
      labels:["gps building start approximate"],
      links:[]
    };
    building.nodes.push(start);
    building.start = start.id;
  }
  currentLocationId = building.start || building.nodes[0].id;
  try {
    saveBuildings();
  } catch (error) {
    $("cameraStatus").textContent = `Could not save this building’s GPS pin: ${error.message}`;
    return false;
  }
  renderBuildingOptions();
  renderAdminLocations();
  updateRoute();
  return true;
}

async function captureBuildingGps() {
  $("cameraStatus").textContent = "Requesting location permission to save this building’s GPS pin…";
  try {
    const position = await getCurrentPosition();
    const accepted = window.confirm(
      `Save this approximate location as the GPS pin for ${getBuilding().name}?\n\n` +
      `GPS accuracy: about ${Math.round(position.coords.accuracy)} m.\n` +
      `This pin is saved only in this browser. It is not an exact indoor position.`
    );
    if (!accepted) {
      $("cameraStatus").textContent = "Building GPS pin not changed.";
      return;
    }
    if (saveBuildingGps(position)) {
      $("cameraStatus").textContent = `GPS pin saved for ${getBuilding().name} (about ${Math.round(position.coords.accuracy)} m accuracy).`;
      announce(`GPS pin saved · ${getBuilding().name}`);
    }
  } catch (error) {
    $("cameraStatus").textContent = error.message;
  }
}

async function locateCurrentBuilding() {
  $("cameraStatus").textContent = "Checking your current location…";
  $("locateButton").disabled = true;
  try {
    const position = await getCurrentPosition();
    const building = getBuilding();
    if (!building.location) {
      $("cameraStatus").textContent = `No GPS pin is saved for ${building.name}. An administrator must set it while at the building.`;
      announce("This building needs a GPS pin first");
      return;
    }
    const difference = distanceBetweenMeters(position.coords, building.location);
    const allowedDistance = building.location.radius + position.coords.accuracy;
    if (difference > allowedDistance) {
      $("cameraStatus").textContent = `Your GPS location is about ${Math.round(difference)} m from ${building.name}. Select the correct building or retry.`;
      announce("Your location did not match this building");
      return;
    }
    const start = building.nodes.find(node => node.id === building.start) || building.nodes[0];
    if (!start) {
      $("cameraStatus").textContent = `GPS confirms ${building.name}, but its indoor map has no locations yet. An administrator needs to map the entrance and rooms.`;
      announce("Building found; its indoor map is not ready");
      return;
    }
    currentLocationId = start.id;
    renderBuildingOptions();
    updateRoute();
    $("cameraStatus").textContent = `GPS matched ${building.name} (about ${Math.round(position.coords.accuracy)} m accuracy). Starting at ${start.name}; GPS cannot identify your room or floor.`;
    announce(`Building found · ${building.name}`);
  } catch (error) {
    $("cameraStatus").textContent = error.message;
  } finally {
    $("locateButton").disabled = false;
  }
}

function removeLocation(id) {
  const building = getBuilding();
  building.nodes = building.nodes.filter(node => node.id !== id);
  for (const node of building.nodes) node.links = node.links.filter(edge => edge.to !== id);
  if (currentLocationId === id) currentLocationId = building.start || building.nodes[0]?.id || "";
  if (destination.value === id) destination.value = "";
  saveBuildings();
  renderBuildingOptions();
  renderAdminLocations();
  updateRoute();
}

$("openAdmin").addEventListener("click", showAdmin);
$("closeAdmin").addEventListener("click", () => $("adminDialog").close());
$("adminDialog").addEventListener("click", event => {
  if (event.target === $("adminDialog")) $("adminDialog").close();
});
$("buildingForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("newBuildingName").value.trim();
  if (!name) return;
  addBuilding(name);
  $("newBuildingName").value = "";
});
$("buildingSelect").addEventListener("change", () => {
  activeBuildingId = $("buildingSelect").value;
  currentLocationId = getBuilding().start || getBuilding().nodes[0]?.id || "";
  saveBuildings();
  renderBuildingOptions();
  renderAdminLocations();
  updateRoute();
});
$("locateButton").addEventListener("click", locateCurrentBuilding);
$("setBuildingGps").addEventListener("click", captureBuildingGps);
$("importOsm").addEventListener("click", importOpenStreetMapData);
$("walkthroughVideo").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  pendingWalkthroughStops = [];
  renderWalkthroughDraft();
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    event.target.value = "";
    $("walkthroughStatus").textContent = "That video is over 50 MB. Choose a shorter walkthrough.";
    return;
  }
  $("walkthroughVideo").disabled = true;
  $("walkthroughStatus").textContent = "Processing video locally. The original is not saved or sent anywhere…";
  try {
    pendingWalkthroughStops = await readVideoStops(file, message => {
      $("walkthroughStatus").textContent = message;
    });
    if (pendingWalkthroughStops.length) {
      $("walkthroughStatus").textContent = `Found ${pendingWalkthroughStops.length} possible stop${pendingWalkthroughStops.length === 1 ? "" : "s"}. Check the detected names, then add them in video order.`;
    } else {
      $("walkthroughStatus").textContent = "No clear sign names found. Try a steady, well-lit video that pauses briefly at room signs, or use advanced manual mapping.";
    }
    renderWalkthroughDraft();
  } catch (error) {
    $("walkthroughStatus").textContent = error.message || "Could not process the walkthrough video.";
  } finally {
    $("walkthroughVideo").disabled = false;
  }
});
$("addWalkthroughStops").addEventListener("click", addWalkthroughStops);
$("signLabelPhotos").addEventListener("change", async event => {
  const files = [...event.target.files];
  event.target.value = "";
  pendingSignLabelCandidates = [];
  renderSignLabelCandidates();
  if (!files.length) return;
  if (files.length > 10 || files.some(file => !file.type.startsWith("image/")) ||
      files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) {
    $("signLabelStatus").textContent = "Choose up to 10 image files with a combined size under 50 MB.";
    return;
  }
  $("signLabelPhotos").disabled = true;
  $("saveSignLabels").disabled = true;
  $("signLabelStatus").textContent = "Reading sign photos locally. Originals are not saved or sent anywhere…";
  try {
    pendingSignLabelCandidates = await recognizeSignPhotos(files, message => {
      $("signLabelStatus").textContent = message;
    });
    $("signLabelStatus").textContent = pendingSignLabelCandidates.length
      ? `Found ${pendingSignLabelCandidates.length} text suggestions. Select only the wording that identifies this stop.`
      : "No readable sign text found. Try a closer, sharper photo or type the wording from the sign.";
    renderSignLabelCandidates();
  } catch (error) {
    $("signLabelStatus").textContent = error.message || "Could not read the sign photos.";
  } finally {
    $("signLabelPhotos").disabled = false;
  }
});
$("saveSignLabels").addEventListener("click", saveSignLabels);
$("signLabelManual").addEventListener("input", updateSignLabelSaveButton);
$("signLabelCandidates").addEventListener("change", updateSignLabelSaveButton);
$("destination").addEventListener("change", updateRoute);
$("cameraButton").addEventListener("click", startCamera);
$("scanButton").addEventListener("click", scanCamera);
$("cameraOffButton").addEventListener("click", closeCamera);
$("printCards").addEventListener("click", printLandmarkCards);
$("demoButton").addEventListener("click", () => {
  const route = calculateRoute(selectedDestination());
  if (route.path[1]) setCurrentLocation(route.path[1]);
  else announce("Choose a connected destination first.");
});
$("locationMedia").addEventListener("change", async event => {
  const file = event.target.files[0] || null;
  event.target.value = "";
  pendingLabels = [];
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    $("mediaStatus").textContent = "That file is over 50 MB. Choose a smaller photo or shorter video.";
    return;
  }
  $("mediaStatus").textContent = "Reading media locally. The original will not be saved or sent anywhere…";
  $("pickPosition").disabled = true;
  $("saveAtCoordinates").disabled = true;
  try {
    pendingLabels = file.type.startsWith("video/")
      ? await readVideoFrames(file, message => { $("mediaStatus").textContent = message; })
      : [await readLandmarkText(await readImage(file))];
    pendingLabels = [...new Set(pendingLabels.filter(Boolean))];
    const recognizedSampleCount = pendingLabels.length;
    pendingLabels = [];
    $("mediaStatus").textContent = recognizedSampleCount
      ? `Read ${recognizedSampleCount} text sample${recognizedSampleCount === 1 ? "" : "s"}; original media discarded. Only the location name you enter will be saved.`
      : `No sign text found. Original media discarded; you can still add this location by name.`;
  } catch (error) {
    $("mediaStatus").textContent = error.message;
  } finally {
    $("pickPosition").disabled = false;
    $("saveAtCoordinates").disabled = false;
  }
});
$("pickPosition").addEventListener("click", () => {
  if (!$("mapLocationName").value.trim()) {
    $("cameraStatus").textContent = "Enter a location name before placing it.";
    return;
  }
  placementMode = true;
  $("adminDialog").close();
  drawMap();
  window.scrollTo(0, 0);
  setTimeout(() => $("map").scrollIntoView({ block:"center" }), 0);
  announce("Click the location’s position on the map");
});
$("saveAtCoordinates").addEventListener("click", () => {
  addLocationAt(
    Math.round(Math.max(25, Math.min(675, Number($("mapLocationX").value) || 350))),
    Math.round(Math.max(25, Math.min(385, Number($("mapLocationY").value) || 207)))
  );
});
$("cancelAddLocation").addEventListener("click", () => {
  $("mapLocationName").value = "";
  $("locationMedia").value = "";
  pendingLabels = [];
  $("mediaStatus").textContent = "Reference media is processed locally and discarded; only recognised text labels are saved.";
});
$("map").addEventListener("click", event => {
  if (!placementMode) return;
  const svg = $("map");
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const coords = point.matrixTransform(svg.getScreenCTM().inverse());
  placementMode = false;
  $("mapLocationX").value = Math.round(Math.max(25, Math.min(675, coords.x)));
  $("mapLocationY").value = Math.round(Math.max(25, Math.min(385, coords.y)));
  addLocationAt(Number($("mapLocationX").value), Number($("mapLocationY").value));
});
window.addEventListener("beforeunload", () => {
  if (stream) stream.getTracks().forEach(track => track.stop());
});

try {
  saveBuildings();
  if (legacyLabelsNeedCleanup) {
    localStorage.setItem("roomroute-label-privacy-cleanup", "complete");
  }
} catch (error) {
  $("cameraStatus").textContent = `Map storage is unavailable: ${error.message}`;
}
clearLegacyReferenceMedia().catch(error => {
  console.error("Could not remove previously saved reference media", error);
  $("cameraStatus").textContent = `Privacy cleanup could not remove previously saved uploads: ${error.message}`;
});
renderBuildingOptions();
renderAdminLocations();
updateRoute();
