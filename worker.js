/**
 * Cloudflare Worker 多项目部署管理器 (最终完整版)
 * * 功能清单：
 * 1. [核心] 自动拉取 GitHub 代码 (beta2.0 / main)。
 * 2. [Token] 支持 GITHUB_TOKEN 环境变量，解除 API 请求限制。
 * 3. [检测] 实时对比上游版本，界面显示 "🔴 有新版本" 提示。
 * 4. [分流] 账号统一存储，Worker 按项目 (CMliu/Joey) 独立管理。
 * 5. [修复] 针对 Joey 项目自动注入 window 补丁。
 */

// ==========================================
// 1. 项目模板配置
// ==========================================
const TEMPLATES = {
  'cmliu': {
    name: "CMliu - EdgeTunnel",
    scriptUrl: "https://raw.githubusercontent.com/cmliu/edgetunnel/beta2.0/_worker.js",
    // GitHub API 地址 (用于版本检测)
    apiUrl: "https://api.github.com/repos/cmliu/edgetunnel/commits/beta2.0",
    defaultVars: ["UUID", "PROXYIP", "PATH", "URL", "KEY", "ADMIN"],
    uuidField: "UUID",
    description: "CMliu 项目 (beta2.0)"
  },
  'joey': {
    name: "Joey - 少年你相信光吗",
    scriptUrl: "https://raw.githubusercontent.com/byJoey/cfnew/main/%E5%B0%91%E5%B9%B4%E4%BD%A0%E7%9B%B8%E4%BF%A1%E5%85%89%E5%90%97",
    // 针对单个文件检测更新
    apiUrl: "https://api.github.com/repos/byJoey/cfnew/commits?path=%E5%B0%91%E5%B9%B4%E4%BD%A0%E7%9B%B8%E4%BF%A1%E5%85%89%E5%90%97&per_page=1",
    defaultVars: ["u"],
    uuidField: "u",
    description: "Joey 项目 (自动修复版)"
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 安全鉴权 (可选)
    const correctCode = env.ACCESS_CODE; 
    const urlCode = url.searchParams.get("code");
    const cookieHeader = request.headers.get("Cookie") || "";
    if (correctCode && !cookieHeader.includes(`auth=${correctCode}`) && urlCode !== correctCode) {
      return new Response(loginHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 初始化 KV 键名
    const type = url.searchParams.get("type") || "cmliu";
    const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`; // 账号统一存
    const VARS_KEY = `VARS_${type}`;                 // 变量分开存
    const VERSION_KEY = `VERSION_INFO_${type}`;      // 版本信息分开存

    // ================= API 路由 =================

    // 1. 账号列表 (GET/POST)
    if (url.pathname === "/api/accounts") {
      if (request.method === "GET") {
        const list = await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]";
        return new Response(list, { headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST") {
        const body = await request.json();
        await env.CONFIG_KV.put(ACCOUNTS_KEY, JSON.stringify(body));
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // 2. 变量配置 (GET/POST)
    if (url.pathname === "/api/settings") {
      if (request.method === "GET") {
        const vars = await env.CONFIG_KV.get(VARS_KEY);
        return new Response(vars || "null", { headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST") {
        const body = await request.json();
        await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(body));
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // 3. 版本检测 (带 GITHUB_TOKEN)
    if (url.pathname === "/api/check_update") {
        return await handleCheckUpdate(env, type, VERSION_KEY);
    }

    // 4. 执行部署 (带 GITHUB_TOKEN)
    if (url.pathname === "/api/deploy" && request.method === "POST") {
      return await handleBatchDeploy(request, env, type, ACCOUNTS_KEY, VERSION_KEY);
    }

    // ================= 页面渲染 =================
    const response = new Response(mainHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (urlCode === correctCode && correctCode) {
      response.headers.set("Set-Cookie", `auth=${correctCode}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
    }
    return response;
  }
};

/**
 * 辅助函数：构造带有 GitHub Token 的请求头
 */
function getGithubHeaders(env) {
    const headers = { "User-Agent": "Cloudflare-Worker-Manager" };
    // 如果你在后台设置了 GITHUB_TOKEN 变量，这里会自动读取
    if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== "") {
        headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
    }
    return headers;
}

/**
 * 后端逻辑：检测更新
 */
async function handleCheckUpdate(env, type, versionKey) {
    try {
        const config = TEMPLATES[type];
        if(!config) return new Response(JSON.stringify({error: "Unknown type"}));

        // 读取本地上次部署记录
        const localDataStr = await env.CONFIG_KV.get(versionKey);
        const localData = localDataStr ? JSON.parse(localDataStr) : null;

        // 请求 GitHub API (带 Token)
        const ghRes = await fetch(config.apiUrl, { headers: getGithubHeaders(env) });
        
        if (!ghRes.ok) {
            // 详细报错提示
            if(ghRes.status === 403) throw new Error("GitHub API 频率超限 (请配置 GITHUB_TOKEN)");
            throw new Error(`GitHub API Error: ${ghRes.status}`);
        }
        
        const ghData = await ghRes.json();
        const commitObj = Array.isArray(ghData) ? ghData[0] : ghData;
        
        const remoteInfo = {
            sha: commitObj.sha,
            date: commitObj.commit.committer.date,
            message: commitObj.commit.message
        };

        return new Response(JSON.stringify({
            local: localData,
            remote: remoteInfo
        }), { headers: { "Content-Type": "application/json" } });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

/**
 * 后端逻辑：批量部署
 */
async function handleBatchDeploy(request, env, type, accountsKey, versionKey) {
  try {
    const { variables } = await request.json(); 
    const templateConfig = TEMPLATES[type];
    
    // 1. 读取账号
    const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
    if (accounts.length === 0) return new Response(JSON.stringify([{ name: "提示", success: false, msg: "请先添加账号" }]));
    
    // 2. 拉取代码 & 版本信息 (带 Token)
    let githubScriptContent = "";
    let currentSha = "";
    
    try {
        // 并行请求：代码(Raw) + 版本信息(API)
        const [codeRes, apiRes] = await Promise.all([
            fetch(templateConfig.scriptUrl),
            fetch(templateConfig.apiUrl, { headers: getGithubHeaders(env) })
        ]);

        if (!codeRes.ok) throw new Error(`代码下载失败: ${codeRes.status}`);
        githubScriptContent = await codeRes.text();

        // 尝试获取版本 SHA 用于记录
        if (apiRes.ok) {
            const apiData = await apiRes.json();
            const commitObj = Array.isArray(apiData) ? apiData[0] : apiData;
            currentSha = commitObj.sha;
        }
    } catch (e) {
        return new Response(JSON.stringify([{ name: "网络错误", success: false, msg: "GitHub连接失败: " + e.message }]));
    }

    // 3. 针对 Joey 项目注入 window 补丁 (关键!)
    if (type === 'joey') {
        githubScriptContent = 'var window = globalThis;\n' + githubScriptContent;
    }

    // 4. 遍历账号进行部署
    const logs = [];
    let updateCount = 0;
    
    for (const acc of accounts) {
      // 这里的逻辑确保只更新当前项目对应的 Worker
      const targetWorkers = acc[`workers_${type}`] || [];
      if (!Array.isArray(targetWorkers) || targetWorkers.length === 0) continue;

      for (const wName of targetWorkers) {
          updateCount++;
          const logItem = { name: `${acc.alias} -> [${wName}]`, success: false, msg: "" };
          let step = "准备";
          
          try {
            const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${wName}`;
            const headers = { "Authorization": `Bearer ${acc.apiToken}` };

            // A. 读取现有配置
            step = "读取配置";
            const bindingsRes = await fetch(`${baseUrl}/bindings`, { headers });
            if (!bindingsRes.ok && bindingsRes.status !== 404) throw new Error(`API错误 ${bindingsRes.status}`);
            const currentBindings = bindingsRes.ok ? (await bindingsRes.json()).result : [];

            // B. 合并变量
            step = "合并变量";
            if (variables && variables.length > 0) {
                for (const newVar of variables) {
                    if (newVar.value && newVar.value.trim() !== "") {
                        const idx = currentBindings.findIndex(b => b.name === newVar.key);
                        if (idx !== -1) currentBindings[idx] = { name: newVar.key, type: "plain_text", text: newVar.value };
                        else currentBindings.push({ name: newVar.key, type: "plain_text", text: newVar.value });
                    }
                }
            }

            // C. 上传部署
            step = "上传部署";
            const metadata = { main_module: "index.js", bindings: currentBindings, compatibility_date: "2024-01-01" };
            const formData = new FormData();
            formData.append("metadata", JSON.stringify(metadata));
            formData.append("script", new Blob([githubScriptContent], { type: "application/javascript+module" }), "index.js");

            const updateRes = await fetch(baseUrl, { method: "PUT", headers, body: formData });
            
            if (updateRes.ok) {
              logItem.success = true;
              logItem.msg = `✅ 更新成功`;
            } else {
              const errData = await updateRes.json();
              logItem.msg = `❌ ${errData.errors?.[0]?.message}`;
            }

          } catch (err) {
            logItem.msg = `❌ [${step}] ${err.message}`;
          }
          logs.push(logItem);
      } 
    }
    
    // 5. 部署成功后，更新本地版本记录
    if (updateCount > 0 && currentSha) {
        await env.CONFIG_KV.put(versionKey, JSON.stringify({ sha: currentSha, deployDate: new Date().toISOString() }));
    }

    if (updateCount === 0) return new Response(JSON.stringify([{ name: "提示", success: true, msg: `当前项目 (${type}) 未配置任何 Worker` }]));

    return new Response(JSON.stringify(logs), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify([{ name: "系统错误", success: false, msg: e.message }]));
  }
}

function loginHtml() { return `<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6"><form method="GET"><input type="password" name="code" placeholder="密码" style="padding:10px"><button style="padding:10px">登录</button></form></body></html>`; }

// ==========================================
// 前端页面代码 (完整展开，方便修改)
// ==========================================
function mainHtml() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Worker 智能中控 (Full Version)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .input-field { border: 1px solid #cbd5e1; padding: 0.5rem; width:100%; border-radius: 4px; transition:all 0.2s;} 
    .input-field:focus { border-color:#3b82f6; outline:none; box-shadow: 0 0 0 2px rgba(59,130,246,0.1); }
    .theme-cmliu { border-color: #ef4444; } 
    .theme-joey { border-color: #3b82f6; }  
    @keyframes pulse-red { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
    .update-badge { animation: pulse-red 2s infinite; }
  </style>
</head>
<body class="bg-slate-100 p-4 md:p-8">
  <div class="max-w-6xl mx-auto space-y-6">
    
    <header class="bg-white p-6 rounded shadow flex flex-col md:flex-row justify-between items-center gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <span>🚀</span> Worker 部署中控
        </h1>
        <div class="text-xs text-gray-500 mt-1 flex gap-4">
            <span id="template_desc">...</span>
        </div>
      </div>
      
      <div class="flex items-center gap-3 bg-slate-50 p-2 rounded border border-blue-100 shadow-sm relative">
        <div class="text-right">
            <div class="text-[10px] text-gray-400 uppercase font-bold">当前项目</div>
            <div class="text-sm font-bold text-blue-600" id="current_project_label">...</div>
        </div>
        <select id="template_select" onchange="switchTemplate()" class="bg-white border border-gray-300 text-gray-900 text-sm rounded focus:ring-blue-500 block p-2 cursor-pointer font-bold">
          <option value="cmliu">🔴 CMliu (EdgeTunnel)</option>
          <option value="joey">🔵 Joey (CFNew)</option>
        </select>
        <span id="update_dot" class="hidden absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full update-badge"></span>
      </div>
    </header>
    
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      
      <div class="lg:col-span-2 bg-white p-6 rounded shadow flex flex-col h-fit">
        <h2 class="font-bold mb-4 border-b pb-2 text-gray-700">📡 账号管理 (通用)</h2>
        
        <div class="bg-slate-50 p-4 mb-4 border rounded shadow-inner">
           <div class="space-y-3 mb-3">
             <div class="flex gap-3">
                 <input id="in_alias" placeholder="备注 (如: 主力账号)" class="input-field w-1/3 font-bold">
                 <input id="in_id" placeholder="Account ID (32位)" class="input-field w-2/3 text-blue-600 font-mono">
             </div>
             <div>
                 <input id="in_token" type="password" placeholder="API Token (必须有 Edit Workers 权限)" class="input-field">
             </div>
             
             <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-gray-200 mt-2">
                 <div>
                    <label class="text-xs font-bold text-red-600 mb-1 block">🔴 CMliu Workers</label>
                    <input id="in_workers_cmliu" placeholder="用逗号隔开" class="input-field font-mono bg-red-50 border-red-200 focus:border-red-400">
                 </div>
                 <div>
                    <label class="text-xs font-bold text-blue-600 mb-1 block">🔵 Joey Workers</label>
                    <input id="in_workers_joey" placeholder="用逗号隔开" class="input-field font-mono bg-blue-50 border-blue-200 focus:border-blue-400">
                 </div>
             </div>
           </div>
           <button onclick="addAccount()" id="btnSave" class="w-full bg-slate-700 text-white py-2 rounded font-bold hover:bg-slate-800 transition shadow-md">保存 / 更新账号</button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-sm text-left">
            <thead class="bg-gray-50 text-gray-500"><tr><th class="p-2 w-1/5">备注</th><th class="p-2">Worker 分配详情</th><th class="p-2 w-20 text-right">操作</th></tr></thead>
            <tbody id="tableBody"></tbody>
          </table>
        </div>
      </div>

      <div id="vars_panel" class="lg:col-span-1 bg-white p-6 rounded shadow h-fit border-t-4 transition-colors duration-300 flex flex-col">
        
        <div id="version_card" class="mb-4 bg-gray-50 border border-gray-200 rounded p-3 text-xs space-y-2 hidden">
            <div class="flex justify-between items-center">
                <span class="font-bold text-gray-500">GitHub 上游:</span>
                <span id="remote_time" class="text-gray-800 font-mono">检测中...</span>
            </div>
            <div class="flex justify-between items-center">
                <span class="font-bold text-gray-500">本地上次部署:</span>
                <span id="local_time" class="text-gray-800 font-mono">...</span>
            </div>
            <div id="update_msg" class="text-center font-bold pt-1 text-green-600"></div>
        </div>

        <h2 class="font-bold mb-4 border-b pb-2 flex justify-between items-center">
          <span>⚙️ 变量配置</span>
          <span onclick="resetVars()" class="text-[10px] text-gray-400 cursor-pointer hover:text-blue-500 underline">强制重置</span>
        </h2>
        
        <div id="vars_container" class="space-y-3 mb-6 min-h-[100px]">
           <div class="text-center text-gray-400 text-xs py-4">读取中...</div>
        </div>
        
        <div class="flex justify-between items-center mb-2">
            <button onclick="addVarRow()" class="text-xs bg-gray-100 px-2 py-1 rounded hover:bg-gray-200 text-gray-600 border">+ 自定义变量</button>
            <span onclick="refreshUUID()" id="btn_refresh_uuid" class="cursor-pointer text-xs text-blue-600 font-bold hover:underline">🎲 刷新</span>
        </div>

        <button onclick="deploy()" id="btnDeploy" class="w-full bg-green-600 hover:bg-green-700 text-white py-3 rounded font-bold transition shadow-lg flex flex-col items-center justify-center gap-0 h-14">
           <span class="text-sm">🔄 立即执行更新</span>
           <span class="text-[10px] font-normal opacity-80" id="deploy_hint">...</span>
        </button>
        
        <div id="logs" class="mt-4 bg-slate-900 text-green-400 p-3 rounded text-xs font-mono hidden max-h-60 overflow-y-auto"></div>
      </div>
    </div>
  </div>

  <script>
    // 定义模板
    const TEMPLATES = {
      'cmliu': { defaultVars: ["UUID", "PROXYIP", "PATH", "URL", "KEY", "ADMIN"], uuidField: "UUID", desc: "CMliu 项目 (标准变量)" },
      'joey':  { defaultVars: ["u"], uuidField: "u", desc: "Joey 项目 (代码修复)" }
    };

    let accounts = [];
    let currentTemplate = 'cmliu';

    // 时间格式化
    function timeAgo(dateString) {
        if(!dateString) return "无记录";
        const date = new Date(dateString);
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds > 86400) return Math.floor(seconds/86400) + " 天前";
        if (seconds > 3600) return Math.floor(seconds/3600) + " 小时前";
        if (seconds > 60) return Math.floor(seconds/60) + " 分钟前";
        return "刚刚";
    }

    // 初始化
    async function init() { 
        const params = new URLSearchParams(window.location.search);
        const type = params.get('type');
        if (type && TEMPLATES[type]) {
            currentTemplate = type;
            document.getElementById('template_select').value = type;
        }
        await loadData();
    }

    async function switchTemplate() {
        currentTemplate = document.getElementById('template_select').value;
        const url = new URL(window.location);
        url.searchParams.set('type', currentTemplate);
        window.history.pushState({}, '', url);
        
        // UI重置
        document.getElementById('vars_container').innerHTML = '<div class="text-center text-gray-400 text-xs py-4">加载中...</div>';
        document.getElementById('version_card').classList.add('hidden');
        await loadData();
    }

    async function loadData() {
        const config = TEMPLATES[currentTemplate];
        document.getElementById('template_desc').innerText = config.desc;
        document.getElementById('current_project_label').innerText = currentTemplate === 'cmliu' ? 'CMliu' : 'Joey';
        document.getElementById('deploy_hint').innerText = \`更新 \${currentTemplate === 'cmliu' ? '🔴 CMliu' : '🔵 Joey'} 的 Worker\`;
        document.getElementById('btn_refresh_uuid').innerText = \`🎲 刷新 \${config.uuidField}\`;
        
        const panel = document.getElementById('vars_panel');
        panel.className = \`lg:col-span-1 bg-white p-6 rounded shadow h-fit border-t-4 transition-colors duration-300 \${currentTemplate === 'cmliu' ? 'theme-cmliu' : 'theme-joey'}\`;

        try {
            const [accRes, settingRes] = await Promise.all([
                fetch(\`/api/accounts\`),
                fetch(\`/api/settings?type=\${currentTemplate}\`)
            ]);
            accounts = await accRes.json();
            const savedSettings = await settingRes.json();
            renderTable(); 
            initVars(savedSettings);

            // 异步检测更新
            checkUpdate();
        } catch(e) { alert("加载失败: " + e.message); }
    }
    
    // 版本检测
    async function checkUpdate() {
        const els = {
            card: document.getElementById('version_card'),
            remote: document.getElementById('remote_time'),
            local: document.getElementById('local_time'),
            msg: document.getElementById('update_msg'),
            dot: document.getElementById('update_dot')
        };
        try {
            const res = await fetch(\`/api/check_update?type=\${currentTemplate}\`);
            const data = await res.json();
            
            if (data.error) throw new Error(data.error);

            els.card.classList.remove('hidden');
            els.remote.innerText = timeAgo(data.remote.date);
            els.local.innerText = data.local ? timeAgo(data.local.deployDate) : "无记录";

            if (!data.local || data.remote.sha !== data.local.sha) {
                els.msg.innerHTML = '<span class="text-red-500">🔴 发现新版本</span>';
                els.dot.classList.remove('hidden');
                document.getElementById('btnDeploy').classList.add('animate-pulse');
            } else {
                els.msg.innerHTML = '<span class="text-green-600">✅ 已是最新</span>';
                els.dot.classList.add('hidden');
                document.getElementById('btnDeploy').classList.remove('animate-pulse');
            }
        } catch(e) {
            console.error(e);
            els.remote.innerText = "检测失败";
        }
    }

    // 初始化变量
    function initVars(savedData) {
        const container = document.getElementById('vars_container');
        container.innerHTML = '';
        
        const defaults = TEMPLATES[currentTemplate].defaultVars;
        const uuidKey = TEMPLATES[currentTemplate].uuidField;
        const savedMap = new Map();
        if (savedData && Array.isArray(savedData)) {
            savedData.forEach(item => savedMap.set(item.key, item.value));
        }

        defaults.forEach(key => {
            let val = savedMap.get(key) || '';
            if (val === '' && key === uuidKey) val = crypto.randomUUID();
            addVarRow(key, val);
            savedMap.delete(key);
        });

        savedMap.forEach((val, key) => {
            addVarRow(key, val);
        });
    }

    function resetVars() {
        if(!confirm("确定要重置为默认变量吗？")) return;
        initVars(null);
    }

    function renderTable() {
      const tb = document.getElementById('tableBody');
      if(accounts.length==0) tb.innerHTML='<tr><td colspan="3" class="text-center text-gray-400 py-4">暂无数据</td></tr>';
      else tb.innerHTML = accounts.map((a,i) => {
        const cmliuList = Array.isArray(a.workers_cmliu) ? a.workers_cmliu : [];
        const cTags = cmliuList.map(w => \`<span class="inline-block bg-red-50 text-red-600 text-[10px] px-1 rounded border border-red-100 mr-1">C:\${w}</span>\`).join('');
        
        const joeyList = Array.isArray(a.workers_joey) ? a.workers_joey : [];
        const jTags = joeyList.map(w => \`<span class="inline-block bg-blue-50 text-blue-600 text-[10px] px-1 rounded border border-blue-100 mr-1">J:\${w}</span>\`).join('');

        const allTags = (cTags + jTags) || '<span class="text-gray-300 text-xs">未分配</span>';
        
        return \`<tr class="border-b hover:bg-gray-50 transition">
          <td class="p-2 font-medium">\${a.alias}</td>
          <td class="p-2">\${allTags}</td>
          <td class="p-2 text-right space-x-1">
            <button onclick="edit(\${i})" class="text-blue-600 text-xs bg-blue-50 px-2 py-1 rounded">改</button>
            <button onclick="del(\${i})" class="text-red-600 text-xs bg-red-50 px-2 py-1 rounded">删</button>
          </td></tr>\`;
      }).join('');
    }

    function edit(i) {
      const a = accounts[i];
      document.getElementById('in_alias').value = a.alias;
      document.getElementById('in_id').value = a.accountId;
      document.getElementById('in_token').value = a.apiToken;
      document.getElementById('in_workers_cmliu').value = (a.workers_cmliu || []).join(', ');
      document.getElementById('in_workers_joey').value = (a.workers_joey || []).join(', ');
      accounts.splice(i,1); renderTable(); 
      const btn = document.getElementById('btnSave'); btn.innerText = "修改中..."; btn.classList.replace('bg-slate-700', 'bg-orange-500');
    }

    async function addAccount() {
      const alias = document.getElementById('in_alias').value.trim();
      const id = document.getElementById('in_id').value.trim();
      const token = document.getElementById('in_token').value.trim();
      const cStr = document.getElementById('in_workers_cmliu').value.trim();
      const jStr = document.getElementById('in_workers_joey').value.trim();

      if(!id || !token) return alert("ID 和 Token 必填");

      accounts.push({
          alias: alias||'未命名', 
          accountId: id, 
          apiToken: token, 
          workers_cmliu: cStr.split(/,|，/).map(s=>s.trim()).filter(s=>s.length>0),
          workers_joey:  jStr.split(/,|，/).map(s=>s.trim()).filter(s=>s.length>0)
      });
      
      await fetch(\`/api/accounts\`, {method:'POST', body:JSON.stringify(accounts)});
      
      // 重置表单
      document.getElementById('in_alias').value = '';
      document.getElementById('in_id').value = '';
      document.getElementById('in_token').value = '';
      document.getElementById('in_workers_cmliu').value = '';
      document.getElementById('in_workers_joey').value = '';
      
      const btn = document.getElementById('btnSave'); btn.innerText = "保存 / 更新账号"; btn.classList.replace('bg-orange-500', 'bg-slate-700');
      renderTable();
    }

    async function del(i) { if(confirm('确定删除?')) { accounts.splice(i,1); await fetch(\`/api/accounts\`, {method:'POST', body:JSON.stringify(accounts)}); renderTable(); } }

    function addVarRow(key = '', val = '') {
      const div = document.createElement('div');
      div.className = 'var-row flex gap-2 items-center';
      div.innerHTML = \`
        <div class="w-1/3"><input class="input-field font-mono text-xs var-key font-bold text-gray-700" value="\${key}" placeholder="Key"></div>
        <div class="w-2/3 flex gap-1"><input class="input-field font-mono text-xs var-val" value="\${val}" placeholder="Value">
        <button onclick="this.parentElement.parentElement.remove()" class="text-gray-400 hover:text-red-500 px-1">×</button></div>
      \`;
      document.getElementById('vars_container').appendChild(div);
    }

    function refreshUUID() {
       const targetKey = TEMPLATES[currentTemplate].uuidField;
       const rows = document.querySelectorAll('.var-row');
       let found = false;
       rows.forEach(row => {
           const keyInput = row.querySelector('.var-key');
           if(keyInput && keyInput.value === targetKey) {
               const valInput = row.querySelector('.var-val');
               valInput.value = crypto.randomUUID();
               valInput.classList.add('bg-green-100');
               setTimeout(() => valInput.classList.remove('bg-green-100'), 500);
               found = true;
           }
       });
       if(!found) alert(\`未找到变量 \${targetKey}\`);
    }

    async function deploy() {
      const keys = document.querySelectorAll('.var-key');
      const vals = document.querySelectorAll('.var-val');
      const variables = [];
      for(let i=0; i<keys.length; i++) {
          const k = keys[i].value.trim();
          const v = vals[i].value.trim();
          if(k) variables.push({key: k, value: v});
      }

      const btn = document.getElementById('btnDeploy'); btn.disabled=true; 
      const log = document.getElementById('logs'); log.classList.remove('hidden'); log.innerHTML = '正在分析...';
      
      try {
        await fetch(\`/api/settings?type=\${currentTemplate}\`, {method: 'POST', body: JSON.stringify(variables)});
        const res = await fetch(\`/api/deploy?type=\${currentTemplate}\`, {method:'POST', body:JSON.stringify({variables})});
        const data = await res.json();
        
        // 部署成功后，重新检测一下状态
        checkUpdate();

        log.innerHTML = data.map(l => \`<div class="\${l.success?'text-green-400':'text-red-400'} border-b border-gray-700 mb-1 pb-1">[\${l.success?'✔':'✘'}] \${l.name}<br><span class="text-gray-500 ml-4">\${l.msg}</span></div>\`).join('');
      } catch(e) { log.innerHTML = \`<div class="text-red-500">\${e.message}</div>\`; }
      btn.disabled=false; 
    }
    
    init();
  </script>
</body></html>
  `;
}
