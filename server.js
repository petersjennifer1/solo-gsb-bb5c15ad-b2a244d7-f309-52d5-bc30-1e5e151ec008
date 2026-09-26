/**
 * 折页小册子拼版服务
 *
 * 功能：
 * - 接收按阅读顺序排列的多页 PDF
 * - 按每帖 1 或 2 张纸分帖（每帖 4 或 8 页），仅在末帖补空白
 * - 生成 A4 横向双面拼版 PDF（每张纸 2 个输出面，每面左右各放一页）
 * - 折页方式：每张 A4 横向纸沿竖直中线对折，得到 A5 竖向小册
 * - 打印方式：A4 横向、双面、短边翻转（沿短边方向翻转）
 */

'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const { PDFDocument, degrees } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// A4 尺寸（点）：竖向 595.28 x 841.89
const PAGE_W = 595.28;
const PAGE_H = 841.89;

/**
 * 生成分帖拼版计划
 *
 * @param {number} sourceCount 原 PDF 页数（按阅读顺序）
 * @param {number} sheetsPerSignature 每帖纸张数：1（每帖 4 页）或 2（每帖 8 页）
 * @returns {{sourceCount, sheetsPerSignature, pagesPerSignature, totalPadded, blankCount, signatures}}
 */
function buildPlan(sourceCount, sheetsPerSignature) {
  const pagesPerSignature = sheetsPerSignature * 4;
  const signatureCount = Math.ceil(sourceCount / pagesPerSignature);
  const totalPadded = signatureCount * pagesPerSignature;

  // 输出顺序上的页码槽位：1..totalPadded（超过 sourceCount 的为空白，用 null 表示）
  const slotAt = (globalPos) => (globalPos <= sourceCount ? globalPos : null);

  const signatures = [];
  for (let sig = 0; sig < signatureCount; sig++) {
    const sigStart = sig * pagesPerSignature + 1; // 本帖在总顺序中的起始页码
    const sheets = [];

    // 套帖：第 k 张（由外向内）的 4 个页码（书序，1 起）
    // 正面（先打印）：左 = 本帖最后一页，右 = 本帖第一页
    // 反面（后打印）：左 = 第 (2k+2) 页，右 = 倒数第 (2k+1) 页
    for (let k = 0; k < sheetsPerSignature; k++) {
      sheets.push({
        sheetIndex: k + 1,
        front: {
          left: slotAt(sigStart + pagesPerSignature - 1 - 2 * k),
          right: slotAt(sigStart + 2 * k),
        },
        back: {
          left: slotAt(sigStart + 2 * k + 1),
          right: slotAt(sigStart + pagesPerSignature - 2 - 2 * k),
        },
      });
    }

    signatures.push({
      signatureIndex: sig + 1,
      startPage: sigStart,
      endPage: Math.min(sigStart + pagesPerSignature - 1, sourceCount),
      sheets,
    });
  }

  return {
    sourceCount,
    sheetsPerSignature,
    pagesPerSignature,
    signatureCount,
    totalPadded,
    blankCount: totalPadded - sourceCount,
    signatures,
  };
}

/**
 * 将源文档各页作为 XObject 嵌入输出文档
 *
 * 注意：
 * - pdf-lib 的 embedPdf 不会应用页面的 /Rotate，这里由调用方在绘制时按旋转角处理
 * - 完全空白（无 Contents 流）的页面无法嵌入，记为 null，绘制时按空白槽位处理
 *
 * @returns {Promise<Array<{embedded: object|null, rotation: number}>>} 与源页一一对应
 */
async function embedSourcePages(outDoc, sourceDoc) {
  const result = [];
  for (const index of sourceDoc.getPageIndices()) {
    const sourcePage = sourceDoc.getPage(index);
    const rotation = sourcePage.getRotation().angle;

    let embedded = null;
    if (sourcePage.node.Contents && sourcePage.node.Contents()) {
      try {
        [embedded] = await outDoc.embedPdf(sourceDoc, [index]);
      } catch (err) {
        embedded = null;
      }
    }
    result.push({ embedded, rotation });
  }
  return result;
}

/**
 * 等比缩放并居中绘制一页到目标区域（应用源页 /Rotate，使阅读方向正确）
 *
 * @param entries embedSourcePages() 的结果（0 起）
 * @param sourcePageNumber 书序页码（1 起），null 表示末帖补的空白槽位
 */
function drawFittedPage(targetPage, entries, sourcePageNumber, boxX, boxY, boxW, boxH) {
  if (sourcePageNumber === null || sourcePageNumber === undefined) return;

  const entry = entries[sourcePageNumber - 1];
  if (!entry || !entry.embedded) return; // 源页本身是空白页，留空即可

  const { embedded, rotation } = entry;
  const rot = ((rotation % 360) + 360) % 360;
  const sideways = rot === 90 || rot === 270;

  // 嵌入盒是未应用旋转的原始盒；旋转后宽高互换
  const fittedW = sideways ? embedded.height : embedded.width;
  const fittedH = sideways ? embedded.width : embedded.height;

  const scale = Math.min(boxW / fittedW, boxH / fittedH);
  const drawW = fittedW * scale;
  const drawH = fittedH * scale;

  // PDF 旋转角为逆时针：/Rotate 90（顺时针显示）对应绘制时逆时针转 90°
  // 旋转矩阵围绕原点，平移偏移按角度补偿，使旋转后的盒子落入目标区域并居中
  // （逆时针 90° 时，源盒映射为 x∈[tx-drawW,tx]、y∈[ty,ty+drawH]，故 tx=origin+drawW）
  const originX = boxX + (boxW - drawW) / 2;
  const originY = boxY + (boxH - drawH) / 2;
  let drawX;
  let drawY;
  if (rot === 90) {
    drawX = originX + drawW;
    drawY = originY;
  } else if (rot === 270) {
    drawX = originX;
    drawY = originY + drawH;
  } else if (rot === 180) {
    drawX = originX + drawW;
    drawY = originY + drawH;
  } else {
    drawX = originX;
    drawY = originY;
  }

  targetPage.drawPage(embedded, {
    x: drawX,
    y: drawY,
    xScale: scale,
    yScale: scale,
    rotate: degrees(rot),
  });
}

/**
 * 根据拼版计划生成 A4 横向双面拼版 PDF
 *
 * @param {PDFDocument} sourceDoc 已加载的原文档（保留原始 /Rotate 供绘制使用）
 * @param {object} plan buildPlan() 的返回值
 * @returns {Promise<PDFDocument>} 拼版后的 PDF 文档（调用方自行 save()）
 */
async function createImposedPdf(sourceDoc, plan) {
  const outDoc = await PDFDocument.create();

  // 将源 PDF 的各页作为 XObject 嵌入（按阅读顺序），drawPage 时按书序页码取用
  const pageEntries = await embedSourcePages(outDoc, sourceDoc);

  // 横向 A4：宽 841.89，高 595.28，左右两半各为一张竖向 A5
  const halfW = PAGE_H / 2;
  const gap = 6;

  // 按帖顺序、每帖由外向内，每张纸依次输出：正面、反面
  for (const sig of plan.signatures) {
    for (const sheet of sig.sheets) {
      for (const side of ['front', 'back']) {
        const page = outDoc.addPage([PAGE_H, PAGE_W]); // A4 横向
        const { left, right } = sheet[side];

        drawFittedPage(page, pageEntries, left, gap, gap, halfW - gap * 1.5, PAGE_W - gap * 2);
        drawFittedPage(
          page,
          pageEntries,
          right,
          halfW + gap * 0.5,
          gap,
          halfW - gap * 1.5,
          PAGE_W - gap * 2
        );
      }
    }
  }

  outDoc.setTitle('折页拼版 PDF');
  outDoc.setProducer('社区折页拼版工具');

  return outDoc;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/impose', upload.single('pdf'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请先上传 PDF 文件。' });
    }

    const sheetsPerSignature = Number(req.body.sheetsPerSignature);
    if (![1, 2].includes(sheetsPerSignature)) {
      return res.status(400).json({ error: '每帖纸张数只能是 1 或 2。' });
    }

    let sourceDoc;
    try {
      sourceDoc = await PDFDocument.load(req.file.buffer, { ignoreEncryption: true });
    } catch (err) {
      return res.status(400).json({ error: '无法解析该文件，请确认上传的是有效的 PDF。' });
    }

    const sourceCount = sourceDoc.getPageCount();
    if (sourceCount < 2) {
      return res.status(400).json({ error: 'PDF 至少需要 2 页才能拼版。' });
    }

    const plan = buildPlan(sourceCount, sheetsPerSignature);
    const imposedDoc = await createImposedPdf(sourceDoc, plan);
    const pdfBuffer = await imposedDoc.save();

    res.json({
      ...plan,
      outputPages: plan.signatureCount * sheetsPerSignature * 2, // 每张纸正反 2 个拼版面
      outputSheets: plan.signatureCount * sheetsPerSignature,
      pdfBase64: pdfBuffer.toString('base64'),
    });
  } catch (err) {
    next(err);
  }
});

// multer 错误（文件过大等）及兜底错误处理
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `文件过大，请上传小于 ${MAX_UPLOAD_MB}MB 的 PDF。` });
  }
  console.error(err);
  res.status(500).json({ error: '服务器处理出错，请重试。' });
});

// 仅在直接运行时启动服务（被 require 时只导出函数，便于测试）
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`折页拼版服务已启动： http://localhost:${PORT}`);
  });
}

module.exports = { app, buildPlan, createImposedPdf, PORT };
