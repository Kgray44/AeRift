export const cases = [
['workspace',680,560,0.75,[{x:15.31,y:60.72,width:645,height:404,radius:19.5,kind:'panel'},{x:40,y:150,width:210,height:135,radius:16,kind:'panel'},{x:275,y:150,width:210,height:135,radius:16,kind:'panel'},{x:524,y:75,width:107,height:36,radius:18,kind:'control'},{x:17,y:15,width:37,height:37,radius:18.5,kind:'stage'}],{}],
['mobile',355,768,.91,[{x:-5.5,y:162.23,width:354,height:400,radius:24,kind:'panel'},{x:9,y:267,width:148,height:172,radius:22,kind:'panel'},{x:172,y:267,width:148,height:172,radius:22,kind:'panel'},{x:306.2,y:731,width:62,height:42,radius:17,kind:'control'}],{}],
['ambient',144,104,1,[{x:.5,y:2,width:143,height:101,radius:25.5,kind:'stage'}],{}],
['alternate',98,80,1.15,[{x:10.7,y:-3.4,width:92,height:55,radius:29,kind:'panel'},{x:35.1,y:38,width:40,height:40,radius:20,kind:'stage'},{x:2.2,y:16,width:38,height:57,radius:18,kind:'control'}],{exposure:125,softness:0,distortion:97,warmth:44,light:1,reflection:82,radius:17}],
];

export const phases = [0, .17, .892, 4.44];
export function sceneFor(w, h) {
  return Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : (Math.imul(i, 37) ^ i >>> 2 ^ Math.floor(i / (w * 4)) * 13) & 255);
}
