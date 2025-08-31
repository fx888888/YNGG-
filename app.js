// app.js - 大逃杀前端（本地模拟 + GameManager 链交互）
// 请确保页面加载 ethers.js（index.html 已包含 CDN）

// ========== 配置（请修改合约地址为你部署的 GameManager 合约） ==========
const YNGG_ADDRESS = "0x07522E355D5e36A5A82599d9C9D3A9bAeA9FA678"; // 你给的 YNGG 地址
let GM_CONTRACT_ADDRESS = ""; // 可在页面输入或部署后替换

// Minimal ABI for GameManager functions we use
const GM_ABI = [
  "function createMatch(string matchKey, uint256 maxPlayers, uint256 entryFee) external",
  "function joinMatch(string matchKey) external",
  "function startMatch(string matchKey) external",
  "function distributeReward(string matchKey, address winner) external",
  "function getMatchInfo(string matchKey) view returns (bytes32 id,uint256 maxPlayers,uint256 currentPlayers,uint256 entryFee,uint256 prizePool,uint8 state)",
  "function getPlayers(string matchKey) view returns (address[])",
  "event PlayerJoined(bytes32 indexed matchId, address indexed player)"
];

// Minimal ERC20 ABI (approve / allowance)
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)"
];

// ========== UI elements ==========
const connectBtn = document.getElementById('connectBtn');
const addrDiv = document.getElementById('addr');
const ynggAddrEl = document.getElementById('ynggAddr');
const gmAddrInput = document.getElementById('gmAddr');
const matchKeyInput = document.getElementById('matchKey');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const startBtn = document.getElementById('startBtn');
const localStartBtn = document.getElementById('localStartBtn');
const statusEl = document.getElementById('status');
const prizePoolEl = document.getElementById('prizePool');
const playerCountEl = document.getElementById('playerCount');
const leaderboardEl = document.getElementById('leaderboard');
const refreshBoardBtn = document.getElementById('refreshBoard');

ynggAddrEl.innerText = YNGG_ADDRESS;

// ========== Ethers provider / signer ==========
let provider, signer, userAddress;
let gmContract = null;
let ynggContract = null;

async function connectWallet(){
  try {
    if (!window.ethereum) { alert("请安装 MetaMask 或支持的浏览器钱包"); return; }
    provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();
    userAddress = await signer.getAddress();
    addrDiv.innerText = `${userAddress.slice(0,6)}...${userAddress.slice(-4)}`;

    // update contracts if GM address provided
    const gmAddr = gmAddrInput.value.trim();
    if (gmAddr) {
      GM_CONTRACT_ADDRESS = gmAddr;
      gmContract = new ethers.Contract(GM_CONTRACT_ADDRESS, GM_ABI, signer);
      ynggContract = new ethers.Contract(YNGG_ADDRESS, ERC20_ABI, signer);
    } else {
      // create huyện placeholder read-only contracts if needed
      ynggContract = new ethers.Contract(YNGG_ADDRESS, ERC20_ABI, signer);
    }

    connectBtn.innerText = "已连接";
    connectBtn.disabled = true;
    setStatus("钱包已连接");
  } catch (e) {
    console.error(e);
    alert("连接失败: " + (e.message || e));
  }
}
connectBtn.addEventListener('click', connectWallet);

// ========== Chain helpers ==========
function setStatus(txt){ statusEl.innerText = txt; }

createBtn.addEventListener('click', async ()=>{
  // owner creates a match: for demo, set maxPlayers=8, entryFee = 10 YNGG (assuming token 18 decimals)
  const key = matchKeyInput.value.trim();
  if (!key) return alert("请输入房间名");
  if (!gmContract) return alert("请先输入 GameManager 合约并连接钱包");
  try {
    // example: entryFee 10 tokens -> adjust decimals if token has 18 decimals
    const entryFeeHuman = prompt("请输入入场费（YNGG），例如 10：", "10");
    if (!entryFeeHuman) return;
    const decimals = 18;
    const entryFee = ethers.utils.parseUnits(entryFeeHuman, decimals);
    const maxPlayersStr = prompt("请输入房间最大人数（示例 8）:", "8");
    const maxPlayers = parseInt(maxPlayersStr) || 8;
    setStatus("发送 createMatch 交易...");
    const tx = await gmContract.createMatch(key, maxPlayers, entryFee);
    await tx.wait();
    setStatus("房间已创建，tx: " + tx.hash.slice(0,10) + "...");
  } catch (e) {
    console.error(e);
    alert("创建失败: " + (e.data?.message || e.message || e));
  }
});

joinBtn.addEventListener('click', async ()=>{
  const key = matchKeyInput.value.trim();
  if (!key) return alert("请输入房间名");
  if (!gmContract || !ynggContract) return alert("请先输入 GameManager 合约并连接钱包");
  try {
    // get match info to know entryFee
    const info = await gmContract.getMatchInfo(key);
    const entryFee = info[3]; // entryFee
    if (entryFee == 0) {
      // just call joinMatch (no token)
      const tx = await gmContract.joinMatch(key);
      setStatus("joining...");
      await tx.wait();
      setStatus("已加入（免费）");
      return;
    }

    // check allowance
    const allowance = await ynggContract.allowance(userAddress, GM_CONTRACT_ADDRESS);
    if (allowance.lt(entryFee)){
      // approve
      setStatus("正在授权合约花费入场费...");
      const ap = await ynggContract.approve(GM_CONTRACT_ADDRESS, entryFee);
      await ap.wait();
    }

    setStatus("调用 joinMatch...");
    const tx = await gmContract.joinMatch(key);
    await tx.wait();
    setStatus("已加入房间，tx: " + tx.hash.slice(0,8));
    await updateMatchInfoDisplay(key);
  } catch (e) {
    console.error(e);
    alert("加入失败: " + (e.data?.message || e.message || e));
  }
});

startBtn.addEventListener('click', async ()=>{
  const key = matchKeyInput.value.trim();
  if (!key) return alert("请输入房间名");
  if (!gmContract) return alert("请先输入 GameManager 合约并连接钱包");
  try {
    setStatus("发送 startMatch...");
    const tx = await gmContract.startMatch(key);
    await tx.wait();
    setStatus("已开始（链上标记）");
  } catch (e) {
    console.error(e);
    alert("startMatch 失败: " + (e.data?.message || e.message || e));
  }
});

gmAddrInput.addEventListener('change', (e)=>{
  const v = e.target.value.trim();
  if (v) {
    GM_CONTRACT_ADDRESS = v;
    if (provider && signer) {
      gmContract = new ethers.Contract(v, GM_ABI, signer);
      ynggContract = new ethers.Contract(YNGG_ADDRESS, ERC20_ABI, signer);
      setStatus("已设置 GameManager 合约地址");
    }
  }
});

async function updateMatchInfoDisplay(key){
  try {
    const info = await gmContract.getMatchInfo(key);
    const currentPlayers = info[2].toString();
    const entryFee = info[3].toString();
    const prizePool = info[4].toString();
    prizePoolEl.innerText = ethers.utils.formatUnits(prizePool, 18);
    playerCountEl.innerText = currentPlayers;
  } catch (e) {
    console.warn("无法读取 matchInfo:", e);
  }
}

refreshBoardBtn.addEventListener('click', ()=>{ renderLeaderboard(); });

// ========== 本地大逃杀模拟（Canvas） ==========

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
let W = canvas.width = canvas.clientWidth;
let H = canvas.height = canvas.clientHeight;

window.addEventListener('resize', ()=> {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  W = canvas.width; H = canvas.height;
});

// Entities: player (you) + bots
class Entity {
  constructor(x,y,color,isPlayer=false){
    this.x = x; this.y = y; this.r = 10;
    this.color = color;
    this.isPlayer = isPlayer;
    this.alive = true;
    this.speed = isPlayer ? 2.5 : (1 + Math.random()*1.4);
    this.kills = 0;
  }
  draw(){
    if (!this.alive) return;
    ctx.beginPath();
    ctx.fillStyle = this.color;
    ctx.arc(this.x, this.y, this.r, 0, Math.PI*2);
    ctx.fill();
    // simple health bar as alive marker
    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    if (this.isPlayer) ctx.fillText("You", this.x-12, this.y-16);
  }
  moveToward(tx,ty){
    if (!this.alive) return;
    const dx = tx - this.x;
    const dy = ty - this.y;
    const d = Math.hypot(dx,dy) || 1;
    this.x += (dx/d) * this.speed;
    this.y += (dy/d) * this.speed;
    // clamp
    this.x = Math.max(this.r, Math.min(W-this.r, this.x));
    this.y = Math.max(this.r, Math.min(H-this.r, this.y));
  }
}

let player, bots = [], inGame = false, localLeaderboard = [];

function setupLocalGame(numBots=7){
  bots = [];
  // spawn player
  player = new Entity(W*0.5, H*0.6, "#ffd166", true);
  for (let i=0;i<numBots;i++){
    const e = new Entity(Math.random()*W, Math.random()*H, "#9fd3ff", false);
    bots.push(e);
  }
  inGame = false;
  render(); // draw initial
}

let mouseX = W/2, mouseY = H/2;
canvas.addEventListener('mousemove', (e)=>{
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
});

localStartBtn.addEventListener('click', ()=>{
  if (inGame) return;
  startLocalMatch();
});

function startLocalMatch(){
  // include player + bots
  inGame = true;
  arenaShrink = 0;
  // reset entities
  setupLocalGame(7);
  player.x = Math.random()*W; player.y = Math.random()*H;
  bots.forEach(b => { b.x = Math.random()*W; b.y = Math.random()*H; b.alive = true; b.kills = 0; });
  loopLocal();
}

// shrink circle
let arenaShrink = 0; // 0..1 (0 full size, 1 tiny)
let shrinkStart = Date.now();

function loopLocal(){
  if (!inGame) return;
  updateLocal();
  render();
  // check end
  const alive = [player, ...bots].filter(e=>e.alive);
  if (alive.length <= 1 || !player.alive) {
    inGame = false;
    // declare winner
    const winner = alive[0];
    const winnerAddr = winner && winner.isPlayer ? (userAddress || "local-player") : ("bot-" + Math.floor(Math.random()*1000));
    setStatus("本局结束，胜者：" + (winnerAddr.slice ? winnerAddr.slice(0,10) : winnerAddr));
    // record leaderboard
    if (winner && winner.isPlayer) {
      localLeaderboard.push({addr: userAddress || "local-player", kills: winner.kills});
      renderLeaderboard();
    }
    return;
  }
  requestAnimationFrame(loopLocal);
}

function updateLocal(){
  // shrink progress
  const elapsed = (Date.now()-shrinkStart)/1000;
  arenaShrink = Math.min(0.92, elapsed / 60); // after 60s nearly full shrink
  // bots move: random wander or toward player if close
  bots.forEach(b=>{
    if (!b.alive) return;
    const d = Math.hypot(player.x - b.x, player.y - b.y);
    if (d < 120) {
      b.moveToward(player.x + (Math.random()*40-20), player.y + (Math.random()*40-20));
    } else {
      // wander
      b.moveToward(Math.random()*W, Math.random()*H);
    }
  });

  // player movement toward mouse
  player.moveToward(mouseX, mouseY);

  // collisions -> simple elimination
  const entities = [player, ...bots].filter(e=>e.alive);
  for (let i=0;i<entities.length;i++){
    for (let j=i+1;j<entities.length;j++){
      const a = entities[i], b = entities[j];
      if (!a.alive || !b.alive) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < (a.r + b.r)) {
        // simple fight: random outcome weighted by isPlayer
        const aPower = a.isPlayer ? 1.1 : 1.0;
        const bPower = b.isPlayer ? 1.1 : 1.0;
        if (Math.random() * (aPower + bPower) < aPower) {
          // a wins
          b.alive = false;
          a.kills += 1;
        } else {
          a.alive = false;
          b.kills += 1;
        }
      }
    }
  }

  // circle damage: anyone outside safe radius loses (instant)
  const cx = W/2, cy = H/2;
  const maxR = Math.min(W,H) * 0.45;
  const minR = 40;
  const curR = maxR * (1 - arenaShrink) + minR;
  [player, ...bots].forEach(e=>{
    if (!e.alive) return;
    const d = Math.hypot(e.x - cx, e.y - cy);
    if (d > curR) {
      // outside -> instant death to speed demo
      e.alive = false;
    }
  });
}

function render(){
  // clear
  ctx.clearRect(0,0,W,H);
  // background grid
  ctx.fillStyle = "#041720";
  ctx.fillRect(0,0,W,H);

  // draw safe circle
  const cx = W/2, cy = H/2;
  const maxR = Math.min(W,H) * 0.45;
  const minR = 40;
  const curR = maxR * (1 - arenaShrink) + minR;
  ctx.beginPath();
  ctx.strokeStyle = "rgba(150,200,255,0.12)";
  ctx.lineWidth = 10;
  ctx.arc(cx, cy, curR, 0, Math.PI*2);
  ctx.stroke();

  // draw entities
  [player, ...bots].forEach(e=>{
    if (e) e.draw();
  });

  // HUD
  ctx.fillStyle = "#fff";
  ctx.font = "14px sans-serif";
  ctx.fillText("玩家: " + (userAddress ? userAddress.slice(0,8) : "未连钱包"), 12, 20);
  const aliveCount = [player, ...bots].filter(e=>e && e.alive).length;
  ctx.fillText("存活: " + aliveCount, 12, 40);
}

// Leaderboard render
function renderLeaderboard(){
  leaderboardEl.innerHTML = '';
  localLeaderboard.slice(-10).reverse().forEach(item=>{
    const li = document.createElement('li');
    li.innerText = `${(item.addr || 'local').slice(0,10)} - 击杀 ${item.kills}`;
    leaderboardEl.appendChild(li);
  });
}

// init
setupLocalGame(7);
renderLeaderboard();
setStatus("准备，本地模拟已就绪");

// ========== Optional: owner distributeWinner (call contract) ==========
async function distributeWinnerOnChain(matchKey, winnerAddr){
  if (!gmContract) return alert("请先连接并设置 GameManager 合约");
  try {
    setStatus("发送分发奖励交易...");
    const tx = await gmContract.distributeReward(matchKey, winnerAddr);
    await tx.wait();
    setStatus("奖励已分发，tx: " + tx.hash.slice(0,10));
  } catch (e) {
    console.error(e);
    alert("分发失败: " + (e.data?.message || e.message || e));
  }
}

// expose distribute for debug (owner)
window.distributeWinnerOnChain = distributeWinnerOnChain;
