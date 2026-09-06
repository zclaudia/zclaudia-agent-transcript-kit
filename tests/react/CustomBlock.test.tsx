import { it, expect } from 'vitest';
import { applyTranscriptEvent, initialTranscriptState, turnText } from '../../src/index.js';
it('custom blocks preserve text interleaving and are idempotent', () => {
 let s=applyTranscriptEvent(initialTranscriptState,{type:'text_delta',turnId:'t',delta:'before'});
 const event={type:'custom_block' as const,turnId:'t',blockId:'image',blockType:'host.image',payload:{ref:'1'}};
 s=applyTranscriptEvent(s,event,{assertEvents:true});
 expect(applyTranscriptEvent(s,event)).toBe(s);
 s=applyTranscriptEvent(s,{type:'text_delta',turnId:'t',delta:'after'});
 const t=s.items[0];if(t.kind!=='assistant_turn')throw Error('turn missing');
 expect(t.blocks.map(b=>b.kind)).toEqual(['text','custom','text']);expect(turnText(t)).toBe('beforeafter');
 expect(()=>applyTranscriptEvent(s,{...event,blockId:''},{assertEvents:true})).toThrow();
});
