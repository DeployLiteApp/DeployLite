"use client";
import {useEffect,useRef,useState} from "react";
import {managedDatabaseDeletePreparationSchema,type ManagedDatabaseDeletePreparationV1} from "@deploylite/contracts";
import {prepareManagedDatabaseDeletion,applyManagedDatabaseDeletion,type PreparedManagedDatabaseDeletion} from "@/lib/managed-database-deletion";
import {Dialog,DialogContent,DialogTitle,DialogDescription} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
type Props={preparation:ManagedDatabaseDeletePreparationV1;apiBaseUrl:string;disabled?:boolean;onDeleted():void;onBusyChange?(busy:boolean):void};
type Attempt={key:string;prepared?:PreparedManagedDatabaseDeletion;uncertain?:boolean};
/** Explicit original approval; cancel never consumes it and uncertainty never creates a replacement. */
export function ManagedDatabaseDeleteControl({preparation,apiBaseUrl,disabled,onDeleted,onBusyChange}:Props) {
  const identity=JSON.stringify([apiBaseUrl,preparation]),current=useRef(identity);current.current=identity;
  const attempts=useRef(new Map<string,Attempt>()),active=useRef<AbortController|null>(null);
  const [opened,setOpened]=useState(false),[busy,setBusy]=useState(false),[,setRevision]=useState(0),[message,setMessage]=useState("");
  const attempt=attempts.current.get(identity);
  useEffect(()=>{
    setOpened(false);setBusy(false);setMessage("");onBusyChange?.(false);
    return()=>{active.current?.abort();active.current=null;onBusyChange?.(false);};
  },[identity,onBusyChange]);
  const expired=attempt?.prepared&&!attempt.uncertain&&Date.parse(attempt.prepared.confirmation.expiresAt)<=Date.now();
  useEffect(()=>{
    if(!opened||!attempt?.prepared||attempt.uncertain)return;
    const remaining=Date.parse(attempt.prepared.confirmation.expiresAt)-Date.now();
    if(remaining<=0)return;
    const timer=setTimeout(()=>setRevision(value=>value+1),Math.min(remaining,60000));return()=>clearTimeout(timer);
  },[opened,attempt?.prepared,attempt?.uncertain]);
  function finish(controller:AbortController){if(active.current===controller){active.current=null;setBusy(false);}}
  async function prepare(){
    if(active.current||disabled)return;
    const previous=attempts.current.get(identity);
    if(previous?.prepared){setOpened(true);setMessage("");onBusyChange?.(true);return;}
    let source:ManagedDatabaseDeletePreparationV1;
    try{source=managedDatabaseDeletePreparationSchema.parse(structuredClone(preparation));}catch{return;}
    const attempt=previous??{key:crypto.randomUUID()};attempts.current.set(identity,attempt);
    const controller=new AbortController();active.current=controller;setBusy(true);setMessage("");onBusyChange?.(true);
    try{
      const result=await prepareManagedDatabaseDeletion(source,{apiBaseUrl,signal:controller.signal},attempt.key);
      if(controller.signal.aborted||current.current!==identity)return;
      if(result.kind==="ready"){attempt.prepared=result.prepared;setOpened(true);}
      else{setMessage("Deletion preparation could not be confirmed.");onBusyChange?.(false);}
    }catch{if(!controller.signal.aborted&&current.current===identity){setMessage("Deletion preparation could not be confirmed.");onBusyChange?.(false);}}
    finally{finish(controller);setRevision(value=>value+1);}
  }
  async function apply(){
    const attempt=attempts.current.get(identity);if(active.current||!attempt?.prepared)return;
    if(!attempt.uncertain&&Date.parse(attempt.prepared.confirmation.expiresAt)<=Date.now()){setMessage("The original approval has expired.");return;}
    const controller=new AbortController();active.current=controller;setBusy(true);setMessage("");
    try{
      const result=await applyManagedDatabaseDeletion(attempt.prepared,{apiBaseUrl,signal:controller.signal});
      if(controller.signal.aborted||current.current!==identity)return;
      if(result.kind==="ready"){setOpened(false);onBusyChange?.(false);onDeleted();}
      else{attempt.uncertain=true;setMessage("Deletion could not be confirmed. Retry the original confirmation.");}
    }catch{if(!controller.signal.aborted&&current.current===identity){attempt.uncertain=true;setMessage("Deletion could not be confirmed. Retry the original confirmation.");}}
    finally{finish(controller);setRevision(value=>value+1);}
  }
  function cancel(){if(active.current)return;setOpened(false);setMessage("");onBusyChange?.(false);}
  return <div>
    <Button variant="destructive" disabled={disabled||busy||opened} onClick={()=>void prepare()}>{attempt&&!attempt.prepared?"Retry deletion preparation":"Delete database"}</Button>
    {message&&!opened?<p role="status">{message}</p>:null}
    <Dialog open={opened&&Boolean(attempt?.prepared)} onOpenChange={value=>{if(!value)cancel();}}>
      <DialogContent showCloseButton={false}>
      <DialogTitle>Delete database</DialogTitle><p>Delete {preparation.databaseId}?</p>
      <DialogDescription>Persistent storage and credentials will be retained.</DialogDescription>
      {message?<p role="status">{message}</p>:null}
      <Button variant="destructive" disabled={busy||Boolean(expired)} onClick={()=>void apply()}>{attempt?.uncertain?"Retry deletion confirmation":"Confirm deletion"}</Button>
      <Button variant="outline" disabled={busy} onClick={cancel}>Cancel</Button>
      </DialogContent>
    </Dialog>
  </div>;
}
