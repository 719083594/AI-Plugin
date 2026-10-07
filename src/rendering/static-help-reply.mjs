import {createStaticHelpReader} from './static-help.mjs';

/** Delivery of prebuilt public instructions. The caller retains command rights.
 * This path never starts a renderer or reads account/configuration values. */
export function createFixedHelpDelivery({root,defaultPrefix}={}){
 const read=createStaticHelpReader({root,...(defaultPrefix?{defaultPrefix}:{})});
 return async(event,topic,{prefix,image=bytes=>globalThis.segment?.image?.(bytes)}={})=>{
  let images;try{images=read({topic,private:false,...(prefix?{prefix}:{})});}catch{return false;}
  if(!images?.length)return false;
  let sent=0;
  try{
   for(const bytes of images){
    const segment=image(bytes);if(!segment)throw new Error('STATIC_HELP_IMAGE_API_UNAVAILABLE');
    const receipt=await event.reply(segment,Boolean(event.isGroup||event.group_id));
    if(receipt===false||receipt?.error||receipt?.retcode>0||receipt?.discarded)throw new Error('STATIC_HELP_SEND_FAILED');
    sent++;
   }
   return true;
  }catch{if(sent)throw new Error('STATIC_HELP_SEND_INCOMPLETE');return false;}
 };
}
