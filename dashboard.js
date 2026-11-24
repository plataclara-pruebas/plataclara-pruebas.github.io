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
    dashboard.querySelectorAll('.chart rect').forEach(function(bar){
      var title=bar.querySelector('title');bar.setAttribute('tabindex','0');if(title)bar.setAttribute('aria-label',title.textContent);
      bar.addEventListener('pointerenter',function(){showTip(bar);});bar.addEventListener('pointerleave',hideTip);
      bar.addEventListener('focus',function(){showTip(bar);});bar.addEventListener('blur',hideTip);
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
