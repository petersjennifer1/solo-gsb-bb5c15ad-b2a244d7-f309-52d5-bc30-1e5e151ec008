/**
 * 折页小册子拼版服务
 *
 * 功能：
 * - 接收按阅读顺序排列的多页 PDF
 * - 可选“章节起页”：指定原页安排为右页（书序奇数位置），必要时在其前插入空白
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
 * 解析“章节起页”输入：以逗号分隔的原 PDF 页码（1 起），留空表示不指定
 *
 * @param {*} raw 表单字段值
 * @param {number} sourceCount 原 PDF 页数
 * @returns {number[]} 升序去重后的章节起页数组（可能为空）
 * @throws {Error} 输入含重复、非整数或越界页码时抛出（message 可直接返回给用户）
 */
function parseChapterStarts(raw, sourceCount) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];

  const seen = new Set();
  const pages = [];
  for (const token of String(raw).split(/[,，]/)) {
    const text = token.trim();
    if (text === '') {
      throw new Error('章节起页存在空的页码项，请检查逗号分隔的输入。');
    }
    if (!/^\d+$/.test(text)) {
      throw new Error(`章节起页 "${text}" 不是正整数，请用逗号分隔填写原 PDF 页码。`);
    }
    const page = Number(text);
    if (page < 1 || page > sourceCount) {
      throw new Error(`章节起页 ${page} 超出范围，应在 1 至 ${sourceCount} 之间。`);
    }
    if (seen.has(page)) {
      throw new Error(`章节起页 ${page} 重复，请去重后再提交。`);
    }
    seen.add(page);
    pages.push(page);
  }
  return pages.sort((a, b) => a - b);
}

/**
 * 构造书序（不含末帖补白）：按原页顺序排列，章节起页落在偶数位置时在其前插入空白
 *
 * 书序位置从 1 计，奇数为右页、偶数为左页。插入空白后后续位置顺延，
 * 即后续章节起页的奇偶判断计入此前已插入的空白。
 *
 * @param {number} sourceCount 原 PDF 页数
 * @param {number[]} chapterStarts 章节起页（升序去重，可为空数组）
 * @returns {Array<{type: 'content', sourcePage: number}|{type: 'chapter-blank'}>}
 */
function buildBookSequence(sourceCount, chapterStarts) {
  const chapterSet = new Set(chapterStarts);
  const sequence = [];
  for (let page = 1; page <= sourceCount; page++) {
    if (chapterSet.has(page) && sequence.length % 2 === 1) {
      // 该章节起页将落在偶数位置（左页），先插入一页章节空白使其成为右页
      sequence.push({ type: 'chapter-blank' });
    }
    sequence.push({ type: 'content', sourcePage: page });
  }
  return sequence;
}

/**
 * 生成分帖拼版计划
 *
 * 书序槽位类型（下载 PDF 与逐帖示意共用同一映射）：
 * - content：原 PDF 页（sourcePage 为原页码，1 起）
 * - chapter-blank：为让章节起页落在右页而插入的空白
 * - pad-blank：末帖末尾为凑满整帖补的空白（仅末帖）
 *
 * @param {number} sourceCount 原 PDF 页数（按阅读顺序）
 * @param {number} sheetsPerSignature 每帖纸张数：1（每帖 4 页）或 2（每帖 8 页）
 * @param {number[]} [chapterStarts] 章节起页（升序去重），缺省表示不指定
 * @returns {{sourceCount, chapterStarts, sheetsPerSignature, pagesPerSignature, signatureCount,
 *   bookPageCount, contentCount, chapterBlankCount, padBlankCount, totalPadded, sequence, signatures}}
 */
function buildPlan(sourceCount, sheetsPerSignature, chapterStarts = []) {
  const pagesPerSignature = sheetsPerSignature * 4;

  // 书序 = 原页（含章节空白），末尾追加末帖补白凑满整帖
  const sequence = buildBookSequence(sourceCount, chapterStarts);
  const contentCount = sequence.length;
  const chapterBlankCount = contentCount - sourceCount;
  const signatureCount = Math.ceil(contentCount / pagesPerSignature);
  const totalPadded = signatureCount * pagesPerSignature;
  const padBlankCount = totalPadded - contentCount;
  for (let i = 0; i < padBlankCount; i++) {
    sequence.push({ type: 'pad-blank' });
  }

  // 完整性校验：原页不得遗漏或重复
  const sourcePages = sequence
    .filter((slot) => slot.type === 'content')
    .map((slot) => slot.sourcePage);
  if (
    sourcePages.length !== sourceCount ||
    !sourcePages.every((page, i) => page === i + 1)
  ) {
    throw new Error('书序构造异常：原页出现遗漏或重复。');
  }

  const signatures = [];
  for (let sig = 0; sig < signatureCount; sig++) {
    const start = sig * pagesPerSignature; // 本帖在书序中的起始下标（0 起）
    const slots = sequence.slice(start, start + pagesPerSignature);
    const slotAt = (offset) => slots[offset];

    const sheets = [];

    // 套帖：第 k 张（由外向内）的 4 个槽位（书序位置，1 起）
    // 正面（先打印）：左 = 本帖最后一页，右 = 本帖第一页
    // 反面（后打印）：左 = 第 (2k+2) 页，右 = 倒数第 (2k+1) 页
    for (let k = 0; k < sheetsPerSignature; k++) {
      sheets.push({
        sheetIndex: k + 1,
        front: {
          left: slotAt(pagesPerSignature - 1 - 2 * k),
          right: slotAt(2 * k),
        },
        back: {
          left: slotAt(2 * k + 1),
          right: slotAt(pagesPerSignature - 2 - 2 * k),
        },
      });
    }

    const contentPages = slots
      .filter((slot) => slot.type === 'content')
      .map((slot) => slot.sourcePage);

    signatures.push({
      signatureIndex: sig + 1,
      sourceStart: contentPages.length ? Math.min(...contentPages) : null,
      sourceEnd: contentPages.length ? Math.max(...contentPages) : null,
      chapterBlankCount: slots.filter((slot) => slot.type === 'chapter-blank').length,
      padBlankCount: slots.filter((slot) => slot.type === 'pad-blank').length,
      sheets,
    });
  }

  return {
    sourceCount,
    chapterStarts: [...chapterStarts],
    sheetsPerSignature,
    pagesPerSignature,
    signatureCount,
    bookPageCount: totalPadded,
    contentCount,
    chapterBlankCount,
    padBlankCount,
    totalPadded,
    sequence,
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
 * @param slot 书序槽位（{type:'content', sourcePage} 或空白槽位），空白槽位不绘制
 */
function drawFittedPage(targetPage, entries, slot, boxX, boxY, boxW, boxH) {
  if (!slot || slot.type !== 'content') return;

  const entry = entries[slot.sourcePage - 1];
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

  // 将源 PDF 的各页作为 XObject 嵌入（按阅读顺序），drawPage 时按书序槽位取用
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

    let chapterStarts;
    try {
      chapterStarts = parseChapterStarts(req.body.chapterStarts, sourceCount);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const plan = buildPlan(sourceCount, sheetsPerSignature, chapterStarts);
    const imposedDoc = await createImposedPdf(sourceDoc, plan);
    const pdfBytes = await imposedDoc.save(); // Uint8Array

    res.json({
      ...plan,
      outputPages: plan.signatureCount * sheetsPerSignature * 2, // 每张纸正反 2 个拼版面
      outputSheets: plan.signatureCount * sheetsPerSignature,
      pdfBase64: Buffer.from(pdfBytes).toString('base64'),
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

module.exports = { app, buildPlan, buildBookSequence, parseChapterStarts, createImposedPdf, PORT };
