/* Finance controls for the selected amount. Files stay local until confirmation. */
(function () {
  'use strict';
  var originalRender = renderCellTrace;
  var pendingURL = null, pendingGeneration = 0;
  function disposePhoto() {
    pendingGeneration++;
    if (pendingURL) URL.revokeObjectURL(pendingURL);
    pendingURL = null;
    var panel = document.getElementById('monthly-photo-pending');
    if (panel) panel.remove();
  }
  var originalClose = closeMonthlyWorkbench;
  closeMonthlyWorkbench = function () { disposePhoto(); originalClose(); };
  document.getElementById('cell-trace-back').addEventListener('click', disposePhoto);
  window.addEventListener('pagehide', disposePhoto);
  var originalOpen = openCellTrace;
  openCellTrace = function (address) { disposePhoto(); return originalOpen(address); };

  function labelFor(cell) {
    var report = state.data.monthly_report || {}, display = report.display_data || {};
    var known = (display.cells || []).find(function (row) { return row.cell_address === cell.cell_address; });
    return cell.label || known && known.label || '原表 ' + cell.cell_address;
  }
  async function components(data, context) {
    if (Array.isArray(data.editable_components)) return data.editable_components;
    var queue = (data.precedents || []).slice(), seen = new Set(), result = [];
    while (queue.length && seen.size < 240 && voucherContextCurrent(context)) {
      var next = queue.shift();
      if (!next.cell_address || seen.has(next.cell_address)) continue;
      seen.add(next.cell_address);
      var trace = await collectMonthlyVoucherTrace(next.cell_address, context);
      if (trace.mode === 'formula') queue.push.apply(queue, trace.precedents || []);
      else result.push(Object.assign({}, trace.target, { _trace: trace }));
    }
    if (queue.length) throw Error('组成项较多，尚未读取完整，请稍后重新打开');
    return result;
  }
  function attachEditor(host, data, rootAddress, context) {
    host.closest('.monthly-simple-workbench').selectedTrace = data;
    host.innerHTML = monthlyInlineEditorHtml(data);
    var node = host.querySelector('.monthly-inline-editor');
    if (node) { node.classList.remove('trace-card'); node.style.padding = '0'; }
    bindMonthlyInlineEditor(data);
    // Save still uses the established audited endpoint; return to the selected root.
    var save = document.getElementById('monthly-inline-save');
    if (save && rootAddress !== data.target.cell_address) {
      var saveBase = save.onclick;
      save.onclick = async function () {
        await saveBase();
        if (currentStore() === context.store && document.getElementById('month').value === context.month
          && state.trace.address === data.target.cell_address) await openCellTrace(rootAddress);
      };
    }
  }
  function attachRules(host, data) {
    var rows = data.business_details || [];
    host.innerHTML = '<h4>凭证要求</h4>' + (rows.length ? rows.map(function (row) {
      var waived = row.evidence_policy === 'none';
      return '<label class="simple-voucher-rule"><span>' + esc(row.category || row.title || data.target.label || '当前这一笔')
        + ' · ' + formatAmount(row.amount) + '</span><span><input type="checkbox" data-simple-rule="' + esc(row.business_id)
        + '" data-type="' + esc(row.business_type) + '" ' + (waived ? '' : 'checked ')
        + (data.can_manage_business_evidence_rules ? '' : 'disabled ') + '> 此笔需要凭证</span></label>';
    }).join('') : '<div class="help">请选择上方的组成金额，逐笔设置凭证要求。</div>');
    host.querySelectorAll('[data-simple-rule]').forEach(function (input) {
      input.onchange = async function () {
        var required = input.checked, context = voucherContext(); input.disabled = true;
        try {
          if (!isLocalPreview()) await api('business_evidence_rule_save', {
            store: context.store, business_type: input.dataset.type, business_id: input.dataset.simpleRule,
            evidence_required: required, reason: (required ? '恢复' : '关闭') + '这一笔凭证要求：' + (data.target.label || data.target.cell_address)
          });
          if (!voucherContextCurrent(context)) return;
          var row = rows.find(function (item) { return item.business_id === input.dataset.simpleRule; });
          if (row) row.evidence_policy = required ? 'voucher_required' : 'none';
          toast(required ? '已保存：此笔需要凭证' : '已保存：此笔无需凭证');
        } catch (error) { input.checked = !required; toast(error.message); }
        finally { if (input.isConnected) input.disabled = false; }
      };
    });
  }
  renderCellTrace = function (data) {
    disposePhoto(); originalRender(data);
    var body = document.getElementById('cell-trace-body');
    body.querySelectorAll('.monthly-inline-editor,.business-detail-card').forEach(function (node) { node.remove(); });
    var box = document.createElement('section'); box.className = 'trace-card monthly-simple-workbench';
    var context = voucherContext(), rootAddress = data.target.cell_address;
    box.innerHTML = '<div data-composition></div><div data-amount-editor></div><div data-rules></div>';
    body.prepend(box);
    var editor = box.querySelector('[data-amount-editor]'), rules = box.querySelector('[data-rules]');
    if (data.mode !== 'formula') { attachEditor(editor, data, rootAddress, context); attachRules(rules, data); return; }
    var choose = box.querySelector('[data-composition]');
    choose.innerHTML = '<h4>修改组成金额</h4><div class="help">正在读取可填写的组成项…</div>';
    components(data, context).then(function (cells) {
      if (!box.isConnected || !voucherContextCurrent(context)) return;
      if (!cells.length) { choose.innerHTML = '<div class="help">原表未提供可编辑的组成项，请核对原表。</div>'; return; }
      choose.innerHTML = '<h4>修改组成金额</h4><select aria-label="选择组成金额">' + cells.map(function (cell, i) {
        return '<option value="' + i + '">' + esc(labelFor(cell)) + ' · ' + formatAmount(cell.numeric_value) + '</option>';
      }).join('') + '</select><div class="help">选择一项修改并保存，当前合计随之更新。</div>';
      var selector = choose.querySelector('select'), request = 0;
      selector.onchange = async function () {
        var current = ++request, cell = cells[Number(selector.value)];
        disposePhoto(); box.selectedTrace = null;
        editor.innerHTML = '<div class="help">正在读取…</div>'; rules.innerHTML = '';
        try {
          var trace = cell._trace || await collectMonthlyVoucherTrace(cell.cell_address, context);
          if (current !== request || !box.isConnected || !voucherContextCurrent(context)) return;
          trace.target.label = labelFor(trace.target);
          attachEditor(editor, trace, rootAddress, context); attachRules(rules, trace);
        } catch (error) { if (box.isConnected && current === request) editor.textContent = error.message; }
      };
      selector.onchange();
    }).catch(function (error) { if (box.isConnected) choose.textContent = error.message; });
  };

  // Capture all upload entries inside the amount drawer before legacy auto-upload handlers.
  document.getElementById('view-cell-trace').addEventListener('click', function (event) {
    var button = event.target.closest('#cell-trace-upload-voucher,#monthly-inline-upload,[data-business-voucher-upload]');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    var workbench = button.closest('.monthly-simple-workbench');
    var data = workbench ? workbench.selectedTrace : state.trace.data;
    var context = voucherContext(), target = data && data.target;
    var rootAddress = state.trace.address;
    if (!target || !data.can_upload_vouchers) { toast('当前账号不能上传凭证'); return; }
    var businessType = button.dataset.businessType, businessId = button.dataset.businessVoucherUpload;
    var picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/jpeg,image/png,application/pdf';
    picker.onchange = function () {
      var file = picker.files[0]; if (!file || !voucherContextCurrent(context)) return;
      if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) {
        toast('请选择 10MB 以内的 JPG、PNG 或 PDF'); return;
      }
      disposePhoto(); var generation = pendingGeneration;
      pendingURL = URL.createObjectURL(file);
      var panel = document.createElement('section'); panel.id = 'monthly-photo-pending'; panel.className = 'trace-card';
      panel.innerHTML = '<h4>待保存凭证</h4><div class="help">' + esc(context.store + ' · ' + context.month + ' · ' + (target.label || target.cell_address))
        + '</div>' + (file.type === 'application/pdf' ? '<iframe title="待保存 PDF" src="' + pendingURL + '"></iframe>'
          : '<a href="' + pendingURL + '" target="_blank" rel="noopener"><img alt="待保存凭证，点击放大" src="' + pendingURL + '"></a>')
        + '<div class="help">' + esc(file.name) + ' · 尚未上传</div><div class="field"><label>说明</label><input data-reason maxlength="500" value="补充当前金额凭证"></div>'
        + '<div class="trace-actions"><button type="button" class="primary" data-save-photo>确认保存图片</button><button type="button" class="ghost" data-cancel-photo>取消</button><button type="button" class="secondary" data-replace-photo>重新选择</button></div><div data-photo-status class="help" role="status"></div>';
      var controls = document.querySelector('.monthly-simple-workbench');
      (controls || document.getElementById('cell-trace-body')).appendChild(panel);
      panel.querySelector('[data-cancel-photo]').onclick = disposePhoto;
      panel.querySelector('[data-replace-photo]').onclick = function () { disposePhoto(); button.click(); };
      panel.scrollIntoView({ block: 'nearest' });
      panel.querySelector('[data-save-photo]').onclick = async function () {
        if (!voucherContextCurrent(context) || generation !== pendingGeneration) { disposePhoto(); return; }
        var reason = panel.querySelector('[data-reason]').value.trim();
        if (!reason) { toast('请填写说明'); return; }
        var status = panel.querySelector('[data-photo-status]');
        panel.querySelectorAll('button,input').forEach(function (node) { node.disabled = true; });
        try {
          var common = { store: context.store, filename: file.name, mime_type: file.type, base64: await fileBase64(file), reason: reason };
          if (!voucherContextCurrent(context) || generation !== pendingGeneration) return;
          if (isLocalPreview()) { status.textContent = '预览模式：未上传到正式账'; return; }
          var result;
          if (data.historical || String(businessType).startsWith('history_')) result = await api('history_ledger_evidence_upload', Object.assign(common, { ledger_entry_id: businessId || target.historical_ledger_entry_id || target.id }));
          else if (businessId && businessType !== 'report_cell') result = await api('voucher_upload', Object.assign(common, { record_type: 'unassigned', business_type: businessType, business_id: businessId, business_link_reason: reason, skip_ocr: true, note: reason }));
          else result = await api('voucher_upload', Object.assign(common, { record_type: 'report', record_id: context.report_id, monthly_cell_id: target.id, monthly_cell_reason: reason, skip_ocr: true, note: reason }));
          if (result.cell_link_error) { status.textContent = '文件已上传，但关联失败：' + result.cell_link_error + '。请核对已上传文件，勿重复上传。'; return; }
          toast('凭证已保存');
          if (voucherContextCurrent(context) && generation === pendingGeneration) { disposePhoto(); await openCellTrace(rootAddress); }
        } catch (error) { if (panel.isConnected) status.textContent = '保存未确认：' + error.message; }
        finally { if (panel.isConnected) panel.querySelectorAll('button,input').forEach(function (node) { node.disabled = false; }); }
      };
    };
    picker.click();
  }, true);
})();
