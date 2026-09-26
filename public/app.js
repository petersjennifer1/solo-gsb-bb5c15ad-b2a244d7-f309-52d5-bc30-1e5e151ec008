'use strict';

const form = document.getElementById('impose-form');
const fileInput = document.getElementById('pdf-input');
const fileDrop = document.getElementById('file-drop');
const fileLabel = document.getElementById('file-label');
const submitBtn = document.getElementById('submit-btn');
const formError = document.getElementById('form-error');
const resultCard = document.getElementById('result-card');
const statsEl = document.getElementById('stats');
const signaturesEl = document.getElementById('signatures');
const downloadBtn = document.getElementById('download-btn');

let lastPdfBase64 = null;
let lastFileName = 'booklet-a4-imposed.pdf';

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) {
    fileLabel.textContent = file.name;
    hideError();
  }
});

['dragenter', 'dragover'].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.remove('dragover');
  })
);
fileDrop.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) {
    fileInput.files = e.dataTransfer.files;
    fileLabel.textContent = file.name;
    hideError();
  }
});

function showError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function hideError() {
  formError.hidden = true;
}

function slotHtml(page, side, pos) {
  if (page === null || page === undefined) {
    return `
      <div class="slot blank ${side} ${pos}">
        <span class="slot-num">空白</span>
        <span class="slot-pos">${pos === 'left' ? '左' : '右'}</span>
      </div>`;
  }
  return `
    <div class="slot ${side} ${pos}">
      <span class="slot-num">P${page}</span>
      <span class="slot-pos">${pos === 'left' ? '左页' : '右页'}</span>
    </div>`;
}

function renderResult(data) {
  const stats = [
    ['原 PDF 页数', data.sourceCount],
    ['每帖页数', `${data.pagesPerSignature} 页（${data.sheetsPerSignature} 张纸）`],
    ['总帖数', data.signatureCount],
    ['需纸张数', `${data.outputSheets} 张`],
    ['输出 PDF 面数', data.outputPages],
    ['末帖补空白', `${data.blankCount} 页`],
  ];
  statsEl.innerHTML = stats
    .map(
      ([label, value]) => `
      <div class="stat">
        <span class="stat-label">${label}</span>
        <span class="stat-value">${value}</span>
      </div>`
    )
    .join('');

  signaturesEl.innerHTML = data.signatures
    .map((sig) => {
      const sheets = sig.sheets
        .map((sheet) => {
          return `
          <div class="sheet">
            <div class="sheet-title">第 ${sheet.sheetIndex} 张纸（${
              sheet.sheetIndex === 1 ? '外层' : '内层'
            }）</div>

            <div class="side">
              <span class="side-label">正面</span>
              <div class="sheet-row">
                ${slotHtml(sheet.front.left, 'front', 'left')}
                <div class="fold"></div>
                ${slotHtml(sheet.front.right, 'front', 'right')}
              </div>
            </div>

            <div class="flip-hint">
              <span class="line">↻</span>
              <span>短边翻转（沿短边方向翻到反面）</span>
            </div>

            <div class="side">
              <span class="side-label">反面</span>
              <div class="sheet-row">
                ${slotHtml(sheet.back.left, 'back', 'left')}
                <div class="fold"></div>
                ${slotHtml(sheet.back.right, 'back', 'right')}
              </div>
            </div>
          </div>`;
        })
        .join('');

      return `
      <div class="signature">
        <div class="signature-head">
          第 ${sig.signatureIndex} 帖
          <span class="muted">原书页 P${sig.startPage} – P${sig.endPage}</span>
        </div>
        ${sheets}
      </div>`;
    })
    .join('');
}

function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'application/pdf' });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const file = fileInput.files[0];
  if (!file) {
    showError('请先选择 PDF 文件。');
    return;
  }

  const sheetsPerSignature = new FormData(form).get('sheetsPerSignature');
  const body = new FormData();
  body.append('pdf', file);
  body.append('sheetsPerSignature', sheetsPerSignature);

  submitBtn.disabled = true;
  submitBtn.textContent = '拼版处理中…';

  try {
    const resp = await fetch('/api/impose', { method: 'POST', body });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || '拼版失败，请重试。');
    }

    lastPdfBase64 = data.pdfBase64;
    const base = file.name.replace(/\.pdf$/i, '');
    lastFileName = `${base}-a4-${sheetsPerSignature}张每帖-拼版.pdf`;

    renderResult(data);
    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '开始拼版';
  }
});

downloadBtn.addEventListener('click', () => {
  if (!lastPdfBase64) return;
  const url = URL.createObjectURL(base64ToBlob(lastPdfBase64));
  const a = document.createElement('a');
  a.href = url;
  a.download = lastFileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
