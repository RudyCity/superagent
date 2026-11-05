import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFDict, PDFName, PDFString } from "pdf-lib";
import { editPdf, inspectPdf, extractPdf } from "../src/core/pdf/pdfEngine.js";

let root = "";
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(),"superagent-pdf-form-safety-"));
  const doc = await PDFDocument.create();
  const page = doc.addPage([480,600]);
  const form = doc.getForm();
  const name = form.createTextField("name");
  name.addToPage(page,{x:30,y:480,width:260,height:26});
  const locked = form.createTextField("locked");
  locked.addToPage(page,{x:30,y:420,width:260,height:26});
  locked.setText("KEEP ME");
  locked.enableReadOnly();
  const consent=form.createCheckBox("consent");
  consent.addToPage(page,{x:30,y:370,width:20,height:20});
  const dept=form.createDropdown("department");
  dept.addOptions(["Agroindustri","Teknik","Biosistem"]);
  dept.addToPage(page,{x:30,y:330,width:230,height:24});
  const role=form.createRadioGroup("role");
  role.addOptionToPage("Admin",page,{x:30,y:280,width:15,height:15});
  role.addOptionToPage("User",page,{x:140,y:280,width:15,height:15});
  await fs.writeFile(path.join(root,"form.pdf"),await doc.save({useObjectStreams:false}));

  const xfa=await PDFDocument.load(await fs.readFile(path.join(root,"form.pdf")));
  const object=xfa.context.lookup(xfa.catalog.get(PDFName.of("AcroForm")));
  if (!(object instanceof PDFDict)) throw new Error("Form fixture is missing AcroForm");
  object.set(PDFName.of("XFA"), PDFString.of("dynamic-xfa-placeholder"));
  await fs.writeFile(path.join(root,"xfa.pdf"),await xfa.save({useObjectStreams:false}));
});
afterAll(async () => {if(root) await fs.rm(root,{recursive:true,force:true});});

async function expectFailed(file:string, op: Record<string,unknown>, code:string, source="form.pdf") {
  const inspection=await inspectPdf({inputPath:source},root);
  await expect(editPdf({
    inputPath:source,outputPath:file,expectedInputSha256:inspection.sha256,
    operations:[{op:"fill_form",...op}],
  },root)).rejects.toMatchObject({code});
  await expect(fs.stat(path.join(root,file))).rejects.toMatchObject({code:"ENOENT"});
}

describe("PDF AcroForm strict typed input and fail-closed preservation",()=>{
  it("rejects arbitrary object coercion, checkbox strings and unknown choice values",async()=>{
    await expectFailed("coerce.pdf",{field:"name",value:{secret:"no"}}, "invalid_form_value");
    await expectFailed("checkbox.pdf",{field:"consent",value:"false"}, "invalid_form_value");
    await expectFailed("dropdown.pdf",{field:"department",value:"Unauthorized Department"},"invalid_form_value");
    await expectFailed("radio.pdf",{field:"role",value:"Owner"},"invalid_form_value");
  });
  it("exposes bounded, exact AcroForm choices in read-only inspection",async()=>{
    const info=await inspectPdf({inputPath:"form.pdf"},root);
    const dept=(info.forms as Array<Record<string,unknown>>).find(field=>field.name==="department");
    const role=(info.forms as Array<Record<string,unknown>>).find(field=>field.name==="role");
    expect(dept?.options).toEqual(["Agroindustri","Teknik","Biosistem"]);
    expect(dept?.optionsTruncated).toBe(false);
    expect(role?.options).toEqual(["Admin","User"]);
    expect(info.forms.some((field:Record<string,unknown>)=>field.name==="locked"&&field.readOnly===true)).toBe(true);
  });

  it("never modifies read-only fields; missing fields do not publish output",async()=>{
    await expectFailed("readonly.pdf",{field:"locked",value:"ALTERED"},"form_readonly");
    await expectFailed("missing.pdf",{field:"unknown",value:"value"},"field_not_found");
  });
  it("rejects XFA forms instead of claiming unsafe AcroForm compatibility",async()=>{
    await expectFailed("xfa-filled.pdf",{field:"name",value:"value"},"unsupported_xfa","xfa.pdf");
    const inspected=await inspectPdf({inputPath:"xfa.pdf"},root);
    await expect(editPdf({
      inputPath:"xfa.pdf",outputPath:"xfa-flatten.pdf",expectedInputSha256:inspected.sha256,
      operations:[{op:"flatten_forms"}],
    },root)).rejects.toMatchObject({code:"unsupported_xfa"});
  });
  it("reopens saved AcroForm fields and verifies their values without flattening",async()=>{
    const info=await inspectPdf({inputPath:"form.pdf"},root);
    const saved=await editPdf({
      inputPath:"form.pdf",outputPath:"live-fields.pdf",expectedInputSha256:info.sha256,
      operations:[
        {op:"fill_form",field:"name",value:"Dosen FTAB"},
        {op:"fill_form",field:"consent",value:false},
        {op:"fill_form",field:"department",value:"Teknik"},
      ],
    },root);
    expect(saved.status).toBe("verified");
    expect(saved.formVerification).toBe("all_modified_fields_reopened_and_verified");
    expect((await inspectPdf({inputPath:"live-fields.pdf"},root)).forms).toHaveLength(5);
  });

  it("fills multiple form types and flattens into a new PDF without modifying original",async()=>{
    const source=await fs.readFile(path.join(root,"form.pdf"));
    const inspected=await inspectPdf({inputPath:"form.pdf"},root);
    const result=await editPdf({
      inputPath:"form.pdf",outputPath:"completed.pdf",expectedInputSha256:inspected.sha256,
      operations:[
        {op:"fill_form",field:"name",value:"FTAB UB"},
        {op:"fill_form",field:"consent",value:true},
        {op:"fill_form",field:"department",value:"Biosistem"},
        {op:"fill_form",field:"role",value:"User"},
        {op:"flatten_forms"},
      ],
    },root);
    expect(result.status).toBe("verified");
    expect(result.formVerification).toContain("flattened_fields_removed");
    const filled=await inspectPdf({inputPath:"completed.pdf"},root);
    expect(filled.forms).toHaveLength(0);
    const text=await extractPdf({inputPath:"completed.pdf"},root);
    expect(text.text).toContain("FTAB UB");
    expect(text.text).toContain("Biosistem");
    expect((await fs.readFile(path.join(root,"form.pdf"))).equals(source)).toBe(true);
  });
});
