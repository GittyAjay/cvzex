import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { autoFillJobApplication } from './automation.js';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import multer from 'multer';
import { generatePdf } from 'html-pdf-node';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
//log
// Add validation
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set in environment variables');
  process.exit(1);
}

// Import pdf-parse with require since it's a CommonJS module
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

// Load environment variables
dotenv.config();

const app = express();

// Single Multer configuration to be used across all endpoints
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    // Accept only PDF files
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
}).fields([
  { name: 'resume', maxCount: 1 },
  { name: 'file', maxCount: 1 }
]);

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static('public')); // For serving static files

const resumeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Increased to 20 requests per window
  message: {
    status: 429,
    error: 'You have exceeded the rate limit. Please try again later.',
    retryAfter: 900, // seconds until retry is allowed
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Add skip function for certain conditions (e.g., authenticated users)
  skip: (req) => {
    // Example: skip rate limiting for authenticated users
    return req.headers['x-api-key'] === process.env.TRUSTED_API_KEY;
  },
  // Handler for when rate limit is exceeded
  handler: (req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      nextAvailableRequest: new Date(Date.now() + windowMs).toISOString(),
      message:
        'Please wait before making additional resume optimization requests',
    });
  },
  // Optional: Store rate limit data in a different store (e.g., Redis)
  // store: new RedisStore({
  //   host: process.env.REDIS_HOST,
  //   port: process.env.REDIS_PORT,
  //   password: process.env.REDIS_PASSWORD
  // })
});

// Apply the rate limiter to the optimize-resume endpoints
app.use(['/api/optimize-resume', '/api/optimize-resume/:id'], resumeLimiter);

// Add a route to check remaining rate limit
app.get('/api/optimize-resume/limit-status', resumeLimiter, (req, res) => {
  res.json({
    remainingRequests: res.getHeader('RateLimit-Remaining'),
    resetTime: new Date(
      Number(res.getHeader('RateLimit-Reset')) * 1000
    ).toISOString(),
  });
});
// Store job applications and returns in memory (replace with database in production)
const jobApplications = new Map();
const returns = new Map();
const jobMatches = new Map(); // Store job matching results
const resumeOptimizations = new Map(); // Add this line to store resume optimizations

// Helper function to extract text from URL
async function extractJobDescription(url) {
  try {
    // Configure axios with headers to mimic a real browser
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    };

    // Try direct axios request first
    try {
      const response = await axios.get(url, { headers });
      const $ = cheerio.load(response.data);
      return extractTextFromHTML($);
    } catch (axiosError) {
      // If direct request fails, try with Puppeteer
      console.log('Direct request failed, attempting with Puppeteer...');
      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();
      await page.setUserAgent(headers['User-Agent']);
      
      // Wait longer and handle dynamic content
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      
      // Wait for job description content to load
      await page.waitForSelector('body', { timeout: 10000 });
      
      const content = await page.content();
      await browser.close();
      
      const $ = cheerio.load(content);
      return extractTextFromHTML($);
    }
  } catch (error) {
    throw new Error(`Failed to extract job description: ${error.message}`);
  }
}

// Helper function to extract text from HTML
function extractTextFromHTML($) {
  // Remove unwanted elements
  $('script, style, noscript, iframe, img').remove();
  
  // Try different common selectors for job descriptions
  const selectors = [
    // Common job description selectors
    '.job-description', '#job-description', '[data-test="job-description"]',
    '.description', '#description', '.jobDescriptionText', 
    'section[class*="description"]', 'div[class*="description"]',
    // Common content area selectors
    'main', 'article', '.content', '#content',
    '[role="main"]', '.main-content', '#main-content'
  ];

  let jobDescription = '';
  
  // Try each selector until we find content
  for (const selector of selectors) {
    const element = $(selector);
    if (element.length > 0) {
      jobDescription = element.text().trim();
      if (jobDescription.length > 100) { // Ensure we have substantial content
        break;
      }
    }
  }

  // Fallback to body if no content found
  if (!jobDescription) {
    jobDescription = $('body').text();
  }

  // Clean up the text
  return jobDescription
    .trim()
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .replace(/\n+/g, '\n') // Replace multiple newlines with single newline
    .replace(/[^\x20-\x7E\n]/g, '') // Remove non-printable characters
    .trim();
}

// Helper function to extract text from PDF
async function extractResumeText(pdfBuffer) {
  try {
    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('Empty or invalid PDF buffer');
    }
    const data = await pdfParse(pdfBuffer);
    return data.text;
  } catch (error) {
    throw new Error(`Failed to extract resume text: ${error.message}`);
  }
}

// Helper function to calculate match score using OpenAI
async function calculateMatchScore(jobDescription, resumeText) {
  try {
    console.log('Starting match score calculation...');
    console.log('Job description length:', jobDescription.length);
    console.log('Resume text length:', resumeText.length);

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `You are an expert HR professional who evaluates job candidates. Analyze the job description and resume, then provide a match score from 0-100 and explain key matching points and missing requirements. Start your response with "Match Score: [NUMBER]" where [NUMBER] is between 0 and 100.`,
        },
        { role: 'user', content: `Job Description:\n${jobDescription}` },
        { role: 'user', content: `Resume:\n${resumeText}` },
      ],
      max_tokens: 500,
    });

    console.log('OpenAI API response received');
    const analysis = response.choices[0].message.content;
    
    // Updated regex pattern to match more score formats
    const scorePatterns = [
      /Match Score:\s*(\d{1,3})/i,
      /Score:\s*(\d{1,3})/i,
      /(\d{1,3})(?=\s*\/\s*100|\s*percent|\s*%)/,
      /Rating:\s*(\d{1,3})/i
    ];

    let score = null;
    for (const pattern of scorePatterns) {
      const match = analysis.match(pattern);
      if (match && match[1]) {
        score = parseInt(match[1]);
        if (score >= 0 && score <= 100) {
          break;
        }
      }
    }

    console.log('Score extracted:', score);
    console.log('Analysis length:', analysis.length);
    console.log('First 100 characters of analysis:', analysis.substring(0, 100));

    // Validate score
    if (score === null || isNaN(score) || score < 0 || score > 100) {
      console.error('Invalid score detected:', score);
      console.log('Full analysis:', analysis);
      throw new Error('Failed to extract valid score from analysis');
    }

    return {
      score,
      analysis,
    };
  } catch (error) {
    console.error('Match score calculation error:', {
      message: error.message,
      stack: error.stack,
      cause: error.cause
    });
    throw new Error(`Failed to calculate match score: ${error.message}`);
  }
}

// Helper function to generate PDF
async function generateResumePDF(htmlContent) {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // Add these args for better compatibility
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, {
      waitUntil: 'networkidle0' // Wait until page is fully loaded
    });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
      printBackground: true // Enable background graphics
    });
    await browser.close();
    return pdfBuffer;
  } catch (error) {
    console.error('PDF Generation Error:', error);
    throw new Error(`Failed to generate PDF: ${error.message}`);
  }
}

// Serve return webpage on default path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Job matching endpoint
app.post('/api/match', async (req, res) => {
  try {
    console.log('\n=== Starting Match Endpoint ===');
    
    // Use upload middleware with error handling
    upload(req, res, async function(err) {
      if (err instanceof multer.MulterError) {
        console.error('Multer error:', err);
        return res.status(400).json({
          error: 'File upload error',
          details: err.message
        });
      } else if (err) {
        console.error('Unknown error:', err);
        return res.status(500).json({
          error: 'Unknown error occurred during file upload',
          details: err.message
        });
      }

      try {
        console.log('Request Headers:', req.headers);
        console.log('Request Body:', req.body);
        console.log('Files:', req.files);

        // Get the file from either 'resume' or 'file' field
        const uploadedFile = req.files?.resume?.[0] || req.files?.file?.[0];

        if (!uploadedFile) {
          console.log('Error: No resume file provided');
          return res.status(400).json({
            error: 'Resume file is required'
          });
        }

        const { jobUrl, jobDescription } = req.body;
        console.log('Job Details:', {
          jobUrl,
          jobDescription: jobDescription ? 'Description provided' : 'No description',
          descriptionLength: jobDescription ? jobDescription.length : 0
        });

        // Check if at least one of jobUrl or jobDescription is provided
        if (!jobUrl && !jobDescription) {
          console.log('Error: No job URL or description provided');
          return res.status(400).json({
            error: 'Please provide either a job URL or description'
          });
        }

        // Create a unique ID for this match
        const matchId = uuidv4();
        console.log('Generated matchId:', matchId);

        try {
          console.log('Starting resume text extraction...');
          // Extract resume text
          const resumeText = await extractResumeText(uploadedFile.buffer);
          console.log('Resume text extracted, length:', resumeText.length);

          // Get job description text either from URL or direct input
          let jobDescriptionText;
          if (jobUrl) {
            console.log('Extracting job description from URL:', jobUrl);
            jobDescriptionText = await extractJobDescription(jobUrl);
          } else {
            console.log('Using provided job description');
            jobDescriptionText = jobDescription;
          }
          console.log('Job description text length:', jobDescriptionText.length);

          // Calculate match score
          console.log('Calculating match score...');
          const matchResult = await calculateMatchScore(jobDescriptionText, resumeText);
          console.log('Match score calculated:', matchResult.score);

          // Store the match result
          const matchData = {
            id: matchId,
            status: 'completed',
            score: matchResult.score,
            analysis: matchResult.analysis,
            timestamp: new Date(),
            jobUrl,
            jobDescription: jobDescriptionText
          };
          console.log('Storing match result:', { ...matchData, analysis: 'truncated' });
          jobMatches.set(matchId, matchData);

          // Return the match ID
          console.log('Sending successful response');
          return res.json({
            matchId,
            status: 'completed',
            score: matchResult.score,
            analysis: matchResult.analysis
          });

        } catch (processingError) {
          console.error('Processing error:', processingError);
          // Store failed status
          const failedMatch = {
            id: matchId,
            status: 'failed',
            error: processingError.message,
            timestamp: new Date()
          };
          console.log('Storing failed match:', failedMatch);
          jobMatches.set(matchId, failedMatch);

          throw processingError;
        }
      } catch (error) {
        console.error('Match endpoint error:', {
          message: error.message,
          stack: error.stack
        });
        return res.status(500).json({
          error: 'An error occurred during job matching',
          details: error.message
        });
      }
    });
  } catch (error) {
    console.error('Outer try-catch error:', error);
    return res.status(500).json({
      error: 'An unexpected error occurred',
      details: error.message
    });
  }
});

// Get match status
app.get('/api/match/:id', (req, res) => {
  const match = jobMatches.get(req.params.id);

  if (!match) {
    return res.status(404).json({ error: 'Match not found' });
  }

  res.json(match);
});

// Get all matches
app.get('/api/matches', (req, res) => {
  const matches = Array.from(jobMatches.values());
  res.json(matches);
});

// Handle return submissions
app.post('/api/returns', (req, res) => {
  try {
    const returnData = req.body;
    const returnId = Date.now().toString();

    // Add metadata
    returnData.id = returnId;
    returnData.status = 'pending';
    returnData.createdAt = new Date();
    returnData.updatedAt = new Date();

    // Store return request
    returns.set(returnId, returnData);

    // Send confirmation
    res.status(201).json({
      message: 'Return request received successfully',
      returnId: returnId,
    });
  } catch (error) {
    console.error('Error processing return:', error);
    res.status(500).json({ error: 'Failed to process return request' });
  }
});

// Get all returns
app.get('/api/returns', (req, res) => {
  try {
    const allReturns = Array.from(returns.values());
    res.json(allReturns);
  } catch (error) {
    console.error('Error fetching returns:', error);
    res.status(500).json({ error: 'Failed to fetch returns' });
  }
});

// Get specific return
app.get('/api/returns/:id', (req, res) => {
  try {
    const returnData = returns.get(req.params.id);
    if (!returnData) {
      return res.status(404).json({ error: 'Return not found' });
    }
    res.json(returnData);
  } catch (error) {
    console.error('Error fetching return:', error);
    res.status(500).json({ error: 'Failed to fetch return' });
  }
});

// Update return status
app.patch('/api/returns/:id', (req, res) => {
  try {
    const returnData = returns.get(req.params.id);
    if (!returnData) {
      return res.status(404).json({ error: 'Return not found' });
    }

    // Update return data
    const updatedData = { ...returnData, ...req.body, updatedAt: new Date() };
    returns.set(req.params.id, updatedData);

    res.json(updatedData);
  } catch (error) {
    console.error('Error updating return:', error);
    res.status(500).json({ error: 'Failed to update return' });
  }
});

// Job application routes
app.post('/api/applications/start', async (req, res) => {
  try {
    upload(req, res, async function(err) {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      
      const { jobUrl } = req.body;
      const resumeFile = req.file;

      if (!jobUrl) {
        return res.status(400).json({ error: 'Job URL is required' });
      }

      if (!resumeFile) {
        return res.status(400).json({ error: 'Resume file is required' });
      }

      const applicationId = Date.now().toString();

      jobApplications.set(applicationId, {
        status: 'pending',
        jobUrl,
        resumeFilePath: resumeFile.path,
        startedAt: new Date(),
        completedAt: null,
        error: null,
      });

      autoFillJobApplication(jobUrl, resumeFile.path)
        .then(() => {
          const application = jobApplications.get(applicationId);
          application.status = 'completed';
          application.completedAt = new Date();
          jobApplications.set(applicationId, application);
        })
        .catch((error) => {
          const application = jobApplications.get(applicationId);
          application.status = 'failed';
          application.error = error.message;
          jobApplications.set(applicationId, application);
        });

      res.status(202).json({
        applicationId,
        message: 'Job application automation started',
        status: 'pending',
      });
    });
  } catch (error) {
    console.error('Error starting application:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/applications/:id', (req, res) => {
  const { id } = req.params;
  const application = jobApplications.get(id);

  if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }

  res.json(application);
});

app.get('/api/applications', (req, res) => {
  const applications = Array.from(jobApplications.values());
  res.json(applications);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Update the optimization endpoint
app.post('/api/optimize-resume', async (req, res) => {
  try {
    upload(req, res, async function(err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({
          error: 'File upload error',
          details: err.message
        });
      } else if (err) {
        return res.status(500).json({
          error: 'Unknown error occurred during file upload',
          details: err.message
        });
      }

      try {
        // Get the file from either 'resume' or 'file' field
        const uploadedFile = req.files?.resume?.[0] || req.files?.file?.[0];

        // Input validation
        if ((!req.body.jobUrl && !req.body.jobDescription) || !uploadedFile) {
          return res.status(400).json({
            error: 'Both job details (URL or description) and resume file are required',
            details: {
              jobDetails: (!req.body.jobUrl && !req.body.jobDescription) ? 'Job URL or description is required' : null,
              resume: !uploadedFile ? 'Resume file is required' : null,
            }
          });
        }

        const optimizeId = Date.now().toString();

        // Create resumes directory if it doesn't exist
        const resumesDir = path.join(__dirname, 'public', 'resumes');
        await fs.promises.mkdir(resumesDir, { recursive: true });

        // Initialize optimization record
        resumeOptimizations.set(optimizeId, {
          status: 'processing',
          jobUrl: req.body.jobUrl,
          jobDescription: req.body.jobDescription,
          startedAt: new Date(),
          completedAt: null,
          optimizedResume: null,
          pdfUrl: null,
          error: null,
          progress: 0
        });

        // Process optimization asynchronously
        (async () => {
          try {
            // Update progress stages
            const updateProgress = (progress) => {
              const optimization = resumeOptimizations.get(optimizeId);
              if (optimization) {
                resumeOptimizations.set(optimizeId, { ...optimization, progress });
              }
            };

            updateProgress(20);
            // Get job description text either from URL or direct input
            const jobDescriptionText = req.body.jobUrl 
              ? await extractJobDescription(req.body.jobUrl)
              : req.body.jobDescription;
            
            updateProgress(40);
            const resumeText = await extractResumeText(uploadedFile.buffer);
            
            updateProgress(60);
            const optimized = await generateOptimizedResume(jobDescriptionText, resumeText);
            
            updateProgress(80);
            const pdfBuffer = await generateResumePDF(optimized);

            // Save PDF to public folder
            const pdfFileName = `resume_${optimizeId}.pdf`;
            const pdfPath = path.join(resumesDir, pdfFileName);
            await fs.promises.writeFile(pdfPath, pdfBuffer);

            // Update final status
            resumeOptimizations.set(optimizeId, {
              status: 'completed',
              jobUrl: req.body.jobUrl,
              jobDescription: req.body.jobDescription,
              optimizedResume: optimized,
              pdfUrl: `/resumes/${pdfFileName}`,
              startedAt: resumeOptimizations.get(optimizeId).startedAt,
              completedAt: new Date(),
              progress: 100
            });
          } catch (error) {
            console.error('Optimization processing error:', error);
            resumeOptimizations.set(optimizeId, {
              ...resumeOptimizations.get(optimizeId),
              status: 'failed',
              error: error.message,
              completedAt: new Date()
            });
          }
        })();

        // Return immediate response with tracking ID
        res.status(202).json({
          optimizeId,
          status: 'processing',
          message: 'Resume optimization started',
          statusEndpoint: `/api/optimize-resume/${optimizeId}`
        });

      } catch (error) {
        console.error('Error in optimize-resume endpoint:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          message: error.message
        });
      }
    });
  } catch (error) {
    console.error('Error in optimize-resume endpoint:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Get Optimization Status
app.get('/api/optimize-resume/:id', (req, res) => {
  const optimization = resumeOptimizations.get(req.params.id);
  if (!optimization)
    return res.status(404).json({ error: 'Optimization not found' });
  res.json(optimization);
});

async function generateOptimizedResume(jobDescription, resumeText) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are an expert resume optimization specialist with years of experience in HR and recruitment. 
          Your task is to analyze the provided resume and job description, then generate an optimized version of the resume 
          that better aligns with the job requirements while maintaining truthfulness and authenticity. Return only the raw HTML content for the body section, excluding the <html>, <head>, and <body> tags.`
        },
        {
          role: 'user',
          content: `Job Description:\n${jobDescription}\n\nOriginal Resume:\n${resumeText}\n\n
          Please optimize this resume for the job description by:
          1. Identifying key requirements and skills from the job description
          2. Highlighting relevant experience and skills from the resume that match these requirements
          3. Suggesting improvements to wording and formatting
          4. Adding any missing relevant skills or experiences from the original resume
          5. Maintaining all truthful information - do not fabricate or exaggerate
          
          Return the optimized resume content in clean, properly formatted HTML that maintains professional styling. Exclude the <html>, <head>, and <body> tags.`
        }
      ],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const optimizedContent = response.choices[0].message.content;

    // Wrap the optimized content in the specified HTML structure
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: system-ui, -apple-system, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            color: #333;
        }

        .name {
            font-size: 24px;
            color: #2f4f4f;
            text-align: center;
            margin-bottom: 15px;
        }

        .contact-info {
            text-align: center;
            margin-bottom: 25px;
            font-size: 14px;
        }

        .contact-info a {
            color: #800000;
            text-decoration: none;
        }

        .section-title {
            font-size: 16px;
            color: #2f4f4f;
            border-bottom: 1px solid #ccc;
            margin: 20px 0 15px 0;
            padding-bottom: 5px;
        }

        .job-title {
            font-weight: normal;
            margin: 15px 0 5px 0;
        }

        .job-meta {
            color: #666;
            font-style: italic;
            margin-bottom: 10px;
            font-size: 14px;
        }

        .experience-item ul {
            margin: 10px 0;
            padding-left: 20px;
        }

        .experience-item li {
            margin-bottom: 8px;
            color: #444;
        }

        .education-item {
            margin-bottom: 15px;
        }

        .education-item .date {
            color: #666;
            font-size: 14px;
        }
    </style>
</head>
<body>
    ${optimizedContent}
</body>
</html>
    `;
  } catch (error) {
    console.error('Error generating optimized resume:', error);
    throw new Error('Failed to optimize resume: ' + error.message);
  }
}

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the returns page at http://localhost:${PORT}`);
});

export default app;
