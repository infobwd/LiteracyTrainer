/* app.js — Vanilla JS optimization patch
 * ฟีเจอร์หลัก:
 * 1) Request Queue + Concurrency = 2 (PromiseQueue)
 * 2) Exponential Backoff (500→1000→2000ms, max 3 ครั้ง)
 * 3) Pre-load ข้อสอบ 10 ข้อที่ start + progress bar + cache (state.qCache)
 * 4) ลดการเรียก setSkeletonForQuestion: แสดงข้อจาก cache ทันทีถ้ามี
 * 5) Optimistic Rendering: skeleton สูงสุด 200ms
 * 6) บังคับใช้ Index API เสมอ (getQuestionIndexed / getBundleIndexed)
 * 7) ลด payload fields (qid, prompt, choices, type, difficulty, skill)
 * 8) Graceful 429: ดึงจาก cache ก่อน + retry เบื้องหลัง
 * 9) Performance Monitor: avg load time & cache hit rate
 */
(function(){
  'use strict';

  // --------- Global State ---------
  const state = {
    qCache: [],           // queue ของคำถามที่ preload ไว้
    history: [],          // เก็บข้อที่ทำไปแล้ว
    cursor: -1,           // ชี้ไปยังข้อปัจจุบันใน history
    metrics: {
      totalRequests: 0,
      totalTimeMs: 0,
      cacheHits: 0,
      cacheChecks: 0,
    },
    optimisticTimer: null,
  };

  // ---------- Elements ----------
  const btnStart = document.getElementById('btnStart');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnCheck = document.getElementById('btnCheck');
  const diffSel = document.getElementById('diffSel');
  const skillSel = document.getElementById('skillSel');

  const preloadProgress = document.getElementById('preloadProgress');
  const retryNote = document.getElementById('retryNote');
  const toast = document.getElementById('toast');

  const quizCard = document.getElementById('quizCard');
  const qidView = document.getElementById('qidView');
  const typeView = document.getElementById('typeView');
  const skillView = document.getElementById('skillView');
  const diffView = document.getElementById('diffView');
  const promptView = document.getElementById('promptView');
  const choicesView = document.getElementById('choicesView');
  const answerInput = document.getElementById('answerInput');

  // ---------- Utility ----------
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function now(){ return performance.now(); }
  function fmt(n){ return Number(n).toFixed(0); }

  function showToast(msg, ms=1800){
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(()=>toast.hidden = true, ms);
  }

  function updatePerf(){
    const avg = state.metrics.totalRequests ? (state.metrics.totalTimeMs / state.metrics.totalRequests) : 0;
    const hitRate = state.metrics.cacheChecks ? (state.metrics.cacheHits / state.metrics.cacheChecks * 100) : 0;
    document.getElementById('avgLoad').textContent = `⏱ avg: ${fmt(avg)} ms`;
    document.getElementById('cacheHit').textContent = `📦 hit: ${fmt(hitRate)}%`;
  }

  // ---------- Promise Queue (Concurrency Limit = 2) ----------
  class PromiseQueue {
    constructor(concurrency=2){
      this.concurrency = concurrency;
      this.queue = [];
      this.active = 0;
    }
    push(task){
      return new Promise((resolve, reject)=>{
        this.queue.push({task, resolve, reject});
        this._dequeue();
      });
    }
    _dequeue(){
      while (this.active < this.concurrency && this.queue.length){
        const {task, resolve, reject} = this.queue.shift();
        this.active++;
        task().then(resolve, reject).finally(()=>{
          this.active--;
          this._dequeue();
        });
      }
    }
  }
  const rq = new PromiseQueue(2);

  // ---------- Backoff fetch wrapper ----------
  async function fetchWithRetry(url, options={}, maxRetries=3){
    let attempt = 0;
    let delay = 500;
    for(;;){
      try{
        const t0 = now();
        const res = await fetch(url, options);
        if(res.status === 429){
          // 429: ทำแบบนุ่มนวล — แสดง retry note, backoff แล้วลองใหม่
          retryNote.hidden = false;
          throw new Error('HTTP 429');
        }
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const t1 = now();
        state.metrics.totalRequests++;
        state.metrics.totalTimeMs += (t1 - t0);
        updatePerf();
        retryNote.hidden = true;
        return data;
      }catch(err){
        if(attempt >= maxRetries){
          retryNote.hidden = true;
          console.warn('fetch retry exceeded', err);
          throw err;
        }
        attempt++;
        console.log(`[Retry ${attempt}/${maxRetries}] ${delay}ms`, options);
        retryNote.hidden = false;
        await sleep(delay);
        delay *= 2; // exponential
      }
    }
  }

  // ---------- API ----------
  function apiGetBundleIndexed({skill, difficulty, size=10}){
    // ใช้ action=getBundleIndexed (ลด fields ตามข้อกำหนด)
    const url = new URL(API_BASE);
    url.searchParams.set('action','getBundleIndexed');
    if(skill) url.searchParams.set('skill', skill);
    if(difficulty) url.searchParams.set('difficulty', difficulty);
    url.searchParams.set('size', size);
    return rq.push(()=>fetchWithRetry(url.toString()));
  }

  function apiGetQuestionIndexed({skill, difficulty}){
    const url = new URL(API_BASE);
    url.searchParams.set('action','getQuestionIndexed');
    if(skill) url.searchParams.set('skill', skill);
    if(difficulty) url.searchParams.set('difficulty', difficulty);
    return rq.push(()=>fetchWithRetry(url.toString()));
  }

  function apiGetExplanation(qid){
    const url = new URL(API_BASE);
    url.searchParams.set('action','getExplanation');
    url.searchParams.set('qid', qid);
    return rq.push(()=>fetchWithRetry(url.toString()));
  }

  // ---------- Rendering ----------
  function setSkeleton(on=true){
    if(on){
      quizCard.classList.add('skeleton');
    }else{
      quizCard.classList.remove('skeleton');
    }
  }

  function renderQuestion(q){
    // q: { qid, prompt, choices, type, difficulty, skill }
    qidView.textContent = `QID: ${q.qid ?? '-'}`;
    typeView.textContent = `ชนิด: ${q.type ?? '-'}`;
    skillView.textContent = `ทักษะ: ${q.skill ?? '-'}`;
    diffView.textContent = `ระดับ: ${q.difficulty ?? '-'}`;
    promptView.textContent = q.prompt ?? '—';
    choicesView.innerHTML = '';

    if(Array.isArray(q.choices) && q.choices.length){
      answerInput.classList.add('hidden');
      q.choices.forEach((c, i)=>{
        const li = document.createElement('li');
        li.textContent = c;
        li.tabIndex = 0;
        li.onclick = ()=>{
          [...choicesView.children].forEach(n=>n.classList.remove('active'));
          li.classList.add('active');
        };
        choicesView.appendChild(li);
      });
    }else{
      // คำตอบแบบกรอกเอง
      answerInput.classList.remove('hidden');
      answerInput.value = '';
    }
  }

  function nextFromCache(){
    state.metrics.cacheChecks++;
    if(state.qCache.length){
      const q = state.qCache.shift();
      state.history.push(q);
      state.cursor = state.history.length - 1;
      state.metrics.cacheHits++;
      updatePerf();
      renderQuestion(q);
      return true;
    }
    updatePerf();
    return false;
  }

  async function fetchAndShow(){
    // ถ้า cache มี ให้ใช้ทันที (ไม่ skeleton)
    if(nextFromCache()){
      return;
    }
    // ไม่มี cache จริง ๆ: แสดง skeleton แต่ไม่เกิน 200ms (optimistic)
    setSkeleton(true);
    const optimistic = setTimeout(()=> setSkeleton(false), 200);
    state.optimisticTimer = optimistic;
    try{
      const skill = skillSel.value.trim();
      const difficulty = diffSel.value || '';
      const data = await apiGetQuestionIndexed({skill, difficulty});
      const q = data?.question;
      if(q){
        state.history.push(q);
        state.cursor = state.history.length - 1;
        renderQuestion(q);
      }else{
        showToast('ไม่มีข้อให้แสดง');
      }
    }catch(err){
      console.error('fetchAndShow error', err);
      showToast('เครือข่ายมีปัญหา: จะแสดงจากแคชถ้ามี');
      // 429 / network fail: ลองดึงจาก history ล่าสุดเผื่อยังเห็นได้
      if(state.history.length){
        renderQuestion(state.history[state.cursor]);
      }
    }finally{
      clearTimeout(state.optimisticTimer);
      setSkeleton(false);
    }
  }

  // ---------- Preload Flow ----------
  async function startPreload(){
    const skill = skillSel.value.trim();
    const difficulty = diffSel.value || '';
    preloadProgress.style.width = '0%';
    state.qCache.length = 0; // reset

    let preloaded = 0;
    try{
      const bundle = await apiGetBundleIndexed({skill, difficulty, size: 10});
      const list = Array.isArray(bundle?.questions) ? bundle.questions : [];
      list.forEach(q => state.qCache.push(q));
      preloaded = list.length;
    }catch(err){
      console.warn('bundle preload failed, fall back to single fetches', err);
      // ถ้า bundle fail: ดึงทีละข้อแต่คิวผ่าน queue (ไม่ยิงพร้อมกันเกิน 2)
      const tasks = Array.from({length:10}, ()=> apiGetQuestionIndexed({skill, difficulty}).then(d=>d?.question).catch(()=>null));
      let idx = 0;
      for(const p of tasks){
        try{
          const q = await p;
          if(q){ state.qCache.push(q); preloaded++; }
        }catch(_){}
        idx++;
        preloadProgress.style.width = `${Math.min(100, (idx/10)*100)}%`;
      }
    }

    preloadProgress.style.width = `${Math.min(100, (preloaded/10)*100)}%`;
    if(preloaded>0){
      showToast(`พร้อมแล้ว ${preloaded}/10 ข้อ`);
    }else{
      showToast('ยังไม่สามารถพรีโหลดได้');
    }
  }

  // ---------- Events ----------
  btnStart.onclick = async () => {
    await startPreload();
    await fetchAndShow();
  };

  btnNext.onclick = async () => {
    // ถัดไป: ใช้จาก cache ก่อน แล้ว trigger เติม cache เบื้องหลัง
    if(!nextFromCache()){
      await fetchAndShow();
    }else{
      // เติม cache แบบ background ถ้าคงเหลือต่ำกว่า 4
      if(state.qCache.length < 4){
        const skill = skillSel.value.trim();
        const difficulty = diffSel.value || '';
        apiGetBundleIndexed({skill, difficulty, size: 6}).then(d=>{
          const list = Array.isArray(d?.questions)? d.questions:[];
          list.forEach(q=> state.qCache.push(q));
          console.log('background top-up', list.length);
        }).catch(e=>console.warn('top-up fail', e));
      }
    }
  };

  btnPrev.onclick = () => {
    if(state.cursor > 0){
      state.cursor--;
      renderQuestion(state.history[state.cursor]);
    }else{
      showToast('อยู่ข้อแรกแล้ว');
    }
  };

  btnCheck.onclick = async () => {
    const cur = state.history[state.cursor];
    if(!cur){ return; }
    try{
      const exp = await apiGetExplanation(cur.qid);
      showToast(exp?.explanation ? ('คำอธิบาย: ' + exp.explanation.substring(0,120)+'…') : 'ไม่มีคำอธิบาย');
    }catch(err){
      showToast('ดึงคำอธิบายไม่ได้');
    }
  };

  // เริ่มต้น: ไม่ทำอะไรจนกด Start
  setSkeleton(true);
  setTimeout(()=> setSkeleton(false), 200); // optimistic 初期

})();