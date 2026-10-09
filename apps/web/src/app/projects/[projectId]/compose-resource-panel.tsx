"use client";
import { useCallback,useEffect,useId,useRef,useState } from "react";
import type { ComposeAttachmentPreviewV1,ComposeNetworkAttachmentReceiptV1,ComposePreviewV1,ComposeResourceInspectionViewV1 } from "@deploylite/contracts";
import { Button } from "@/components/ui/button";
import { ComposeResourceCleanupPanel } from "./compose-resource-cleanup-panel";
import { applyProjectComposeNetworkAttachment,inspectProjectComposeResource,previewProjectComposeAttachment } from "./compose-resource-client";

export function ComposeResourcePanel({projectId,apiBaseUrl,document,preview,onCleanupLockChange}:{projectId:string;apiBaseUrl:string|null;document:string;preview:ComposePreviewV1;onCleanupLockChange(locked:boolean):void}){
  const resources=[...preview.networks.map(r=>({kind:"network" as const,key:r.key,runtimeName:r.runtimeName})),...preview.volumes.map(r=>({kind:"volume" as const,key:r.key,runtimeName:r.runtimeName}))];
  const first=resources[0],id=useId();
  const [selection,setSelection]=useState(first?`${first.kind}:${first.key}`:"");
  const [service,setService]=useState(preview.services[0]?.name??"");
  const [inspection,setInspection]=useState<ComposeResourceInspectionViewV1|null>(null);
  const [attachment,setAttachment]=useState<ComposeAttachmentPreviewV1|null>(null);
  const [pending,setPending]=useState<"inspection"|"attachment"|"apply"|null>(null),[error,setError]=useState("");
  const [applyReceipt,setApplyReceipt]=useState<ComposeNetworkAttachmentReceiptV1|null>(null);
  const [cleanupLocked,setCleanupLocked]=useState(false);
  const version=useRef(0),request=useRef<AbortController|null>(null),applyKey=useRef<{fingerprint:string;value:string}|null>(null);
  const handleCleanupLockChange=useCallback((locked:boolean)=>{setCleanupLocked(locked);onCleanupLockChange(locked);},[onCleanupLockChange]);
  const resource=resources.find(r=>`${r.kind}:${r.key}`===selection),selectedService=preview.services.find(s=>s.name===service);
  const desired=resource&&selectedService?(resource.kind==="network"?selectedService.networks.includes(resource.key):selectedService.volumes.some(m=>m.source===resource.key)):false;
  const action:"attach"|"detach"=desired?"attach":"detach";
  const running=inspection?.containers.some(c=>(c.service===service||c.attached)&&c.running)??false;
  function invalidate(clearInspection:boolean){version.current++;request.current?.abort();request.current=null;applyKey.current=null;setPending(null);setError("");setAttachment(null);setApplyReceipt(null);if(clearInspection)setInspection(null);}
  useEffect(()=>{
    invalidate(true);setSelection(first?`${first.kind}:${first.key}`:"");setService(preview.services[0]?.name??"");
    return()=>{version.current++;request.current?.abort();request.current=null;onCleanupLockChange(false);};
  },[projectId,apiBaseUrl,document,preview.configDigest]);
  async function inspect(){
    if(request.current||!resource||!apiBaseUrl)return;
    invalidate(true);const token=version.current,controller=new AbortController();request.current=controller;setPending("inspection");
    const result=await inspectProjectComposeResource({projectId,apiBaseUrl,document,kind:resource.kind,key:resource.key,expectedConfigDigest:preview.configDigest,signal:controller.signal});
    if(request.current!==controller||version.current!==token)return;request.current=null;setPending(null);
    if(result.kind==="ready")setInspection(result.inspection);else setError(result.message);
  }
  async function previewAttachment(){
    if(cleanupLocked||request.current||!resource||!selectedService||!inspection||running||!apiBaseUrl)return;
    invalidate(false);const token=version.current,controller=new AbortController();request.current=controller;setPending("attachment");
    const result=await previewProjectComposeAttachment({projectId,apiBaseUrl,document,kind:resource.kind,key:resource.key,service,action,expectedConfigDigest:preview.configDigest,expectedStateDigest:inspection.stateDigest,signal:controller.signal});
    if(request.current!==controller||version.current!==token)return;request.current=null;setPending(null);
    if(result.kind==="ready")setAttachment(result.preview);else{setInspection(null);setError(result.message);}
  }
  async function applyAttachment(){
    if(cleanupLocked||request.current||resource?.kind!=="network"||!selectedService||!attachment||attachment.alreadySatisfied||!apiBaseUrl)return;
    const proposal={projectId,document,kind:"network" as const,key:resource.key,service,action,expectedConfigDigest:preview.configDigest,
      expectedStateDigest:attachment.stateDigest,expectedContainerId:attachment.containerId};
    const fingerprint=JSON.stringify(proposal);
    if(!applyKey.current||applyKey.current.fingerprint!==fingerprint)applyKey.current={fingerprint,value:globalThis.crypto.randomUUID()};
    const token=++version.current,controller=new AbortController();request.current=controller;setPending("apply");setError("");setApplyReceipt(null);
    const result=await applyProjectComposeNetworkAttachment({...proposal,apiBaseUrl,idempotencyKey:applyKey.current.value,signal:controller.signal});
    if(request.current!==controller||version.current!==token)return;request.current=null;setPending(null);
    if(result.kind==="error"){
      setError(result.message);
      if(!result.retryable){applyKey.current=null;setAttachment(null);setInspection(null);}
      return;
    }
    applyKey.current=null;setInspection(null);setAttachment(null);setApplyReceipt(result.receipt);
  }
  const terminalMessage=applyReceipt
    ?applyReceipt.status==="failed"?"The network change did not reach its requested state. Inspect the resource again before retrying."
      :applyReceipt.status==="already-attached"||applyReceipt.status==="already-detached"?"The requested network state was already satisfied."
      :applyReceipt.status==="attached"?"Network attached. Inspect the resource again to review current use."
      :"Network detached. Inspect the resource again to review current use."
    :null;
  return <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3 text-sm">
    <h3 id={`${id}-heading`} className="font-medium">Inspect resources</h3>
    <p className="text-muted-foreground">Inspect current service use before reviewing an attachment. This review makes no runtime changes.</p>
    {resources.length?<>
      <label htmlFor={`${id}-resource`}>Resource to inspect</label>
      <select id={`${id}-resource`} className="rounded-md border bg-background p-2" value={selection} disabled={cleanupLocked} onChange={e=>{invalidate(true);setSelection(e.target.value);}}>
        {resources.map(r=><option key={`${r.kind}:${r.key}`} value={`${r.kind}:${r.key}`}>{r.kind}: {r.key}</option>)}
      </select>
      <Button type="button" variant="outline" disabled={!!pending||!resource||!apiBaseUrl} onClick={inspect}>{pending==="inspection"?"Inspecting...":"Inspect resource"}</Button>
      <label htmlFor={`${id}-service`}>Service for attachment preview</label>
      <select id={`${id}-service`} className="rounded-md border bg-background p-2" value={service} disabled={cleanupLocked} onChange={e=>{invalidate(false);setService(e.target.value);}}>
        {preview.services.map(s=><option key={s.name} value={s.name}>{s.name}</option>)}
      </select>
      <Button type="button" variant="outline" disabled={cleanupLocked||!!pending||!inspection||!selectedService||running||!apiBaseUrl} onClick={previewAttachment}>{pending==="attachment"?"Checking attachment...":desired?"Preview attachment":"Preview detachment"}</Button>
      {attachment&&resource?.kind==="network"&&!attachment.alreadySatisfied?<Button type="button" disabled={cleanupLocked||!!pending||running||!apiBaseUrl} onClick={applyAttachment}>
        {pending==="apply"?"Applying network change...":action==="attach"?"Apply attachment":"Apply detachment"}
      </Button>:null}
    </>:<p>No declared resources to inspect.</p>}
    {inspection?<section aria-labelledby={`${id}-observed`}>
      <h4 id={`${id}-observed`} className="font-medium">Observed resource use</h4>
      {inspection.containers.length?<ul>{inspection.containers.map((c,i)=><li key={`${c.service}:${i}`}>{c.service}: {c.running?"running":"stopped"}, {c.attached?"attached":"detached"}</li>)}</ul>:<p>No observed consumers.</p>}
      {running?<p>Stop the selected service and running consumers before an attachment preview.</p>:null}
    </section>:null}
    {resource?<ComposeResourceCleanupPanel key={`${resource.kind}:${resource.key}`} projectId={projectId} apiBaseUrl={apiBaseUrl} document={document}
      preview={preview} resource={resource} inspection={inspection} onLockChange={handleCleanupLockChange}/>:null}
    <p role={error?"alert":"status"} aria-live="polite" className={error?"text-destructive":"text-muted-foreground"}>{error||(pending==="apply"?"Applying the reviewed network change...":pending?"Checking current resource state...":terminalMessage??(attachment?attachment.alreadySatisfied?("The requested "+(action==="attach"?"attachment":"detachment")+" is already satisfied. No runtime change was made."):(action==="attach"?"Attachment":"Detachment")+" preview ready. No runtime change was made.":!apiBaseUrl?"Resource inspection is unavailable until the project API is configured.":"Inspect and preview before changing network attachments."))}</p>
  </section>;
}
