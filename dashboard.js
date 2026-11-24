/* Animate the visible scene once; form renders do not restart the dashboard. */
(function(){
  'use strict';
  var scene='',observer=null,tip=null;
  var reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  function hideTip(){document.querySelectorAll('[aria-describedby="pc-chart-tooltip"]').forEach(function(n){n.removeAttribute('aria-describedby');});if(tip){tip.remove();tip=null;}}
  function showTip(bar){
    hideTip();var title=bar.querySelector('title');if(!title)return;
    tip=document.createElement('div');tip.className='pc-chart-tip';tip.setAttribute('role','tooltip');tip.id='pc-chart-tooltip';tip.textContent=title.textContent;
    document.body.appendChild(tip);bar.setAttribute('aria-describedby',tip.id);
    var r=bar.getBoundingClientRect(),t=tip.getBoundingClientRect();
    tip.style.left=Math.max(12,Math.min(innerWidth-t.width-12,r.left+r.width/2-t.width/2))+'px';
    tip.style.top=Math.max(12,r.top-t.height-10)+'px';
  }
  function enhance(){
    var view=document.getElementById('view');if(!view)return;
    var key=view.dataset.scene,animate=key!==scene;scene=key;
    if(observer)observer.disconnect();hideTip();
    var dashboard=view;
    view.classList.add('pc-experience');
    if(animate&&!reduced.matches)view.classList.add('pc-scene-enter');else view.classList.remove('pc-scene-enter');
    dashboard.querySelectorAll('.chart-month').forEach(function(bar){
      function select(){bar.closest('svg').querySelectorAll('.chart-month').forEach(function(n){n.classList.toggle('is-selected',n===bar);n.setAttribute('aria-pressed',String(n===bar));});showTip(bar);}
      bar.addEventListener('pointerenter',function(){showTip(bar);});bar.addEventListener('pointerleave',hideTip);
      bar.addEventListener('focus',function(){showTip(bar);});bar.addEventListener('blur',hideTip);
      bar.addEventListener('click',select);bar.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});
    });
    if(!animate||reduced.matches)return;
    var cards=dashboard.querySelectorAll('.card,.list,.ow-hero,.wallet-deck>[data-a="w-edit"]');
    if(!('IntersectionObserver' in window))return;
    observer=new IntersectionObserver(function(entries){
      var i=0;entries.forEach(function(entry){if(entry.isIntersecting){entry.target.style.setProperty('--dash-delay',(i++*65)+'ms');entry.target.classList.add('dash-reveal');observer.unobserve(entry.target);}});
    },{threshold:.08});
    cards.forEach(function(card){observer.observe(card);});
  }
  document.addEventListener('animationend',function(e){if(e.animationName==='pc-scene')e.target.classList.remove('pc-scene-enter');});
  document.addEventListener('pc-render',enhance);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')hideTip();});
  window.addEventListener('scroll',hideTip,{passive:true});
  reduced.addEventListener('change',function(){if(observer)observer.disconnect();hideTip();document.querySelectorAll('.dash-reveal').forEach(function(n){n.classList.remove('dash-reveal');});});
  enhance();
})();
/* Delegated effects also cover dynamically rendered forms and account screens. */
(function(){
 'use strict';
 var reduce=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(hover: hover) and (pointer: fine)'),lit=null,frame=0;
 var selector='button:not(:disabled),a[href],.seg label',wasSheet=false;
 function clear(){if(lit){lit.classList.remove('pc-lit');lit=null;}}
 document.addEventListener('pointermove',function(e){
  if(!fine.matches)return;
  var card=e.target.closest('.pc-experience .card,.pc-experience .ow-hero,.wallet-deck>[data-a="w-edit"]');
  if(card!==lit){clear();lit=card;if(lit)lit.classList.add('pc-lit');}
  if(!card||frame)return;
  var x=e.clientX,y=e.clientY;frame=requestAnimationFrame(function(){frame=0;if(!card.isConnected)return;var r=card.getBoundingClientRect();card.style.setProperty('--pc-x',(x-r.left)+'px');card.style.setProperty('--pc-y',(y-r.top)+'px');});
 },{passive:true});
 document.addEventListener('pointerleave',clear);
 document.addEventListener('pointerdown',function(e){
  if(reduce.matches||e.button!==0)return;
  var b=e.target.closest(selector);if(!b)return;
  b.classList.add('pc-interactive');var r=b.getBoundingClientRect(),dot=document.createElement('span'),size=Math.max(r.width,r.height)*2;
  dot.className='pc-ripple';dot.setAttribute('aria-hidden','true');dot.style.setProperty('--pc-ripple-size',size+'px');dot.style.setProperty('--pc-ripple-x',(e.clientX-r.left)+'px');dot.style.setProperty('--pc-ripple-y',(e.clientY-r.top)+'px');b.appendChild(dot);setTimeout(function(){dot.remove();},600);
 },{passive:true});
 document.addEventListener('pc-render',function(){clear();document.querySelectorAll('.nav-btn[aria-current="page"],.chip[aria-pressed="true"]').forEach(function(b){b.classList.add('pc-choice');});var open=!!document.querySelector('#sheet .overlay');if(open&&!wasSheet){var fab=document.querySelector('.fab');if(fab)fab.classList.add('pc-choice');}wasSheet=open;});
 document.addEventListener('animationend',function(e){if(['pc-choice','pc-select-pop','pc-select-light'].indexOf(e.animationName)>=0)e.target.classList.remove('pc-choice');});
 reduce.addEventListener('change',clear);
})();
