/* Private originals stay in memory and are discarded when leaving the view. */
(function (root) {
  'use strict';
  root.createZysyrVoucherView = function (options) {
    var core = root.ZysyrVoucherPreview, esc = options.escape, generation = 0;
    function fileView(file, host, retry) {
      var selected = core.selectImages(file), url = core.safeURL(file.file_url), name = file.filename || file.original_filename || '原始凭证';
      var images = selected.images.map(function (item) { return core.safeURL(item.data_url); }).filter(Boolean);
      if (!images.length && url && core.kind(file) === 'image') images.push(url);
      var html = '<h4>' + esc(name) + '</h4>';
      if (file.trace_link_level === 'bundle_only') html += '<div class="candidate-warning">当前关联范围：本月整包凭证，尚未确认哪张对应当前金额。以下展示整包原图，不代表每张都计入该金额。</div>';
      else if (file.trace_link_level === 'page_confirmed') html += '<div class="help">以下为已关联到该金额的原图。</div>';
      if (Number(file.trace_missing_exact_count)) html += '<div class="candidate-warning">仍有组成明细未精确关联单张原图，不能据此认定凭证齐全。</div>';
      if (selected.missing) html += '<div class="candidate-warning">已登记的原图位置无法全部找到，请核对关联。未以整包图片替代精确凭证。</div>';
      if (file.preview_error) html += '<div class="candidate-warning">这份原件暂时未能读取：' + esc(file.preview_error) + '。可在此重试，不影响其他原件。</div>';
      if (images.length) {
        html += '<div class="voucher-gallery-controls"><button type="button" class="ghost" data-step="-1">上一张</button><span data-count aria-live="polite">1 / ' + images.length + '</span><button type="button" class="ghost" data-step="1">下一张</button></div><div class="voucher-gallery-list" tabindex="0" aria-label="原始凭证图片，可左右滑动">';
        html += images.map(function (src, i) { return '<figure class="voucher-gallery-item"><button type="button" class="voucher-image-open" data-zoom="' + i + '" aria-label="放大第 ' + (i + 1) + ' 张原始凭证"><img src="' + esc(src) + '" alt="原始凭证第 ' + (i + 1) + ' 张" loading="' + (i ? 'lazy' : 'eager') + '"></button><figcaption>原图 ' + (i + 1) + ' / ' + images.length + '</figcaption></figure>'; }).join('') + '</div>';
      } else if (url && core.kind(file) === 'pdf') html += '<iframe class="voucher-pdf-preview" title="' + esc(name) + ' PDF 原件预览" src="' + esc(url) + '"></iframe><div class="help">若浏览器不支持 PDF 内嵌预览，可使用下方备用原文件入口。</div>';
      else if (!file.preview_error && !selected.missing) html += '<div class="help">这份附件没有可直接显示的图片或 PDF；保留原文件供核对，不将其冒充消费凭证截图。</div>';
      html += '<div class="trace-actions"><button type="button" class="ghost" data-retry>重新读取原件</button></div>';
      if (url) html += '<details class="trace-source-details"><summary>备用：打开原文件</summary><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(name) + '</a></details>';
      host.innerHTML = html;
      host.querySelector('[data-retry]').onclick = retry;
      bindSlides(host, images);
    }
    function bindSlides(host, images) {
      var strip = host.querySelector('.voucher-gallery-list');
      if (!strip) return;
      var figures = Array.from(strip.children), position = 0;
      function update() {
        position = figures.reduce(function (best, item, i) {
          return Math.abs(item.offsetLeft - figures[0].offsetLeft - strip.scrollLeft) < Math.abs(figures[best].offsetLeft - figures[0].offsetLeft - strip.scrollLeft) ? i : best;
        }, 0);
        host.querySelector('[data-count]').textContent = (position + 1) + ' / ' + figures.length;
        host.querySelector('[data-step="-1"]').disabled = position === 0;
        host.querySelector('[data-step="1"]').disabled = position === figures.length - 1;
      }
      function step(value) { var next = Math.max(0, Math.min(figures.length - 1, position + value)); strip.scrollTo({ left: figures[next].offsetLeft - figures[0].offsetLeft, behavior: 'smooth' }); }
      strip.addEventListener('scroll', update, { passive: true });
      strip.onkeydown = function (event) { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1); } };
      host.querySelectorAll('[data-step]').forEach(function (button) { button.onclick = function () { step(Number(button.dataset.step)); }; });
      host.querySelectorAll('[data-zoom]').forEach(function (button) { button.onclick = function () {
        var dialog = document.createElement('dialog'); dialog.className = 'voucher-zoom-dialog';
        dialog.innerHTML = '<form method="dialog"><button class="secondary">关闭放大</button></form><div class="voucher-zoom-scroll"><img src="' + esc(images[Number(button.dataset.zoom)]) + '" alt="放大的原始凭证"></div>';
        document.body.appendChild(dialog); dialog.addEventListener('close', function () { dialog.remove(); }); dialog.showModal();
      }; });
      host.querySelectorAll('img').forEach(function (img) { img.onerror = function () { if (!img.nextElementSibling) img.insertAdjacentHTML('afterend', '<span class="candidate-warning">图片加载失败或链接过期，请点击重新读取原件。</span>'); }; });
      update();
    }
    async function mount(data, address, context, body) {
      var request = ++generation, details = document.createElement('details'), workbenchCards = Array.from(body.querySelectorAll('.monthly-simple-workbench'));
      if (!workbenchCards.length) workbenchCards = Array.from(body.querySelectorAll('.monthly-inline-editor,.business-detail-card'));
      details.className = 'trace-source-details voucher-trace-details';
      workbenchCards.forEach(function (card) { card.remove(); });
      details.innerHTML = '<summary>需要时查看金额来源、组成明细和修改记录</summary>';
      while (body.firstChild) details.appendChild(body.firstChild);
      var gallery = document.createElement('section'); gallery.className = 'monthly-voucher-preview';
      var target = data.target || {}, header = '<div class="voucher-gallery-summary"><strong>' + esc(target.label || '月报金额') + ' · ' + options.amount(target.numeric_value == null ? target.display_value : target.numeric_value) + '</strong><small>已关联原件直接显示在下方。多张图片可左右滑动查看，点击图片可放大。原件不等于已核对，缺口会单独提示。</small><details class="trace-source-details"><summary>查看原表定位</summary><div>月报原表单元格 ' + esc(address) + '。这是 Excel 定位，不是凭证编号。</div></details></div>';
      gallery.innerHTML = header + '<div class="voucher-gallery-loading">正在收集组成项目的原始凭证…</div>';
      workbenchCards.forEach(function (card) { body.appendChild(card); }); body.appendChild(gallery); body.appendChild(details);
      function active() { return request === generation && gallery.isConnected && options.isCurrent(context); }
      try {
        var collected = await core.collect(data, address, function (cell) { return options.trace(cell, context); }, { active: active });
        if (!active()) return;
        var warnings = [];
        if (collected.failures.length) warnings.push(collected.failures.length + ' 个组成项目读取失败，当前预览不完整');
        if (collected.truncated) warnings.push('组成项目较多，本次尚未读取全部，不能标记凭证齐全');
        if (collected.unresolved) warnings.push(collected.unresolved + ' 个公式缺少可解析的组成项目');
        if (collected.missing_leaves) warnings.push(collected.missing_leaves + ' 个非零组成项目尚未关联凭证');
        gallery.innerHTML = header + (warnings.length ? '<div class="candidate-warning">' + esc(warnings.join('；')) + '。<button class="ghost" data-retry-trace>重新读取</button></div>' : '') + '<div class="help">已读取 ' + collected.leaf_count + ' 个组成项目，关联原件 ' + collected.evidence.length + ' 份。仅展示已有关系，不按文件名猜测关联。</div>';
        var retryTrace = gallery.querySelector('[data-retry-trace]'); if (retryTrace) retryTrace.onclick = function () { options.reopen(address); };
        if (!collected.evidence.length) {
          gallery.insertAdjacentHTML('beforeend', '<div class="candidate-warning">当前金额没有关联可预览的原始凭证。可以直接上传凭证，或将该项目设置为“不需要凭证”；组成明细仍保留在下方，按需展开。</div>');
          return;
        }
        var hosts = collected.evidence.map(function (file) {
          var host = document.createElement('section'); host.className = 'trace-card voucher-file-preview';
          host.innerHTML = '<h4>' + esc(file.original_filename || '原始凭证') + '</h4><div class="voucher-gallery-loading">正在读取原图…</div>';
          gallery.appendChild(host); return host;
        });
        function show(file, index) { fileView(file, hosts[index], async function () {
          hosts[index].innerHTML = '<div class="voucher-gallery-loading">正在重新读取…</div>';
          try { var result = await options.load(collected.evidence[index], context, data.historical); if (active()) show(result, index); }
          catch (error) { if (active()) show(Object.assign({}, collected.evidence[index], { preview_error: error.message }), index); }
        }); }
        await core.loadFiles(collected.evidence, function (file) { return options.load(file, context, data.historical); }, show, active);
      } catch (error) {
        if (active()) gallery.innerHTML = header + '<div class="candidate-warning">凭证预览读取失败：' + esc(error.message) + '。下方追溯与修改记录仍可核对。</div>';
      }
    }
    return { mount: mount, cancel: function () { generation++; }, fileView: fileView };
  };
})(window);
