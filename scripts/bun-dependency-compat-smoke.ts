/**
 * Bun dependency compatibility acceptance. All data is synthetic and in-memory.
 * Covers safe xmldom/Mammoth, SheetJS alias, JSON patch and native libvips.
 */
import mammoth from 'mammoth';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import sharp from 'sharp';
import { create } from 'jsondiffpatch';

if (!process.versions.bun) throw new Error('Bun required');
const zip = new JSZip();
zip.file('[Content_Types].xml',
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('_rels/.rels',
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file('word/document.xml',
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>BUN_SAFE_DOCX</w:t></w:r></w:p></w:body></w:document>');
const docx = await zip.generateAsync({ type: 'nodebuffer' });
const parsed = await mammoth.extractRawText({buffer: docx});
if (!parsed.value.includes('BUN_SAFE_DOCX')) throw new Error('DOCX parser compatibility failure');

const excel = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(excel, XLSX.utils.aoa_to_sheet([['k','BUN_SAFE_XLSX']]), 'data');
const xlsx = XLSX.write(excel, {bookType:'xlsx', type:'buffer'});
const reopened = XLSX.read(xlsx, {type:'buffer'});
if (!XLSX.utils.sheet_to_csv(reopened.Sheets.data).includes('BUN_SAFE_XLSX')) throw new Error('XLSX parser compatibility failure');

const source = {count: 1};
const delta = create().diff(source, {count:2});
const updated = create().patch({...source}, delta);
if (updated.count !== 2) throw new Error('JSON diff/patch compatibility failure');

const png = await sharp({create:{width:16,height:16,channels:4,
  background:{r:15,g:25,b:35,alpha:1}}}).png().toBuffer();
const meta = await sharp(png).metadata();
if (meta.width!==16 || meta.height!==16) throw new Error('Sharp native image processing failure');

console.log('BUN_DEPENDENCY_COMPAT_OK DOCX XLSX JSONPATCH SHARP');
