'use strict';
// Runs as tvm-renderer with a minimal environment and no application credentials.
const fs=require('node:fs'),{generateFromMaster}=require('./master-pdf'),{generatePdf}=require('./pdf');
(async()=>{let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>200000)throw Error('Input too large');}const {data,options}=JSON.parse(input);const result=options?.masterPath&&fs.existsSync(options.masterPath)?await generateFromMaster(data,options):await generatePdf(data,options);process.stdout.write(JSON.stringify({pages:result.pages,pdf:result.pdf.toString('base64')}));})().catch(()=>{process.exitCode=1;});
