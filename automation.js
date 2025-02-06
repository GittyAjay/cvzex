import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import axios from 'axios';
import OpenAI from 'openai';

// Load environment variables
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
/**
 * Advanced field mapping using Ollama
 * @param {Array} formFields - List of form field names
 * @param {Object} userData - User data for mapping
 * @returns {Promise<Object>} Mapped form data
 */
async function intelligentFieldMapping(formFields, userData) {
  const systemMessage = `
    You are an expert AI assistant for mapping form fields to user data.
    Analyze form field names and match them to user data.
    Return ONLY a valid JSON object with the mappings - no comments or explanations.
    For unknown or unmappable fields, either omit them or use empty strings.
  `;

  const prompt = `
    ${systemMessage}
    
    Match these form fields to the most relevant user data:
    Form Fields: ${JSON.stringify(formFields)}
    User Data: ${JSON.stringify(userData)}
    
    Return only a JSON object with the mappings.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: prompt },
      ],
      max_tokens: 500,
    });

    const content = response.choices[0].message.content;

    // Clean up the response before parsing
    const cleanedContent = content
      .replace(/\/\/.+/g, '')
      .replace(/\n/g, '')
      .trim();

    try {
      return JSON.parse(cleanedContent);
    } catch (jsonError) {
      console.error('JSON Parsing Error:', jsonError);
      console.error('Cleaned Content:', cleanedContent);
      return {};
    }
  } catch (error) {
    console.error('OpenAI Mapping Error:', error);
    return {};
  }
}

/**
 * Fill form fields dynamically
 * @param {Object} page - Puppeteer page object
 * @param {Object} mappedData - Mapped form data
 */
async function fillFormFields(page, mappedData) {
  await page.evaluate((data) => {
    // Helper function to find best input element for a field
    function findInputElement(fieldName) {
      const selectors = [
        `input[name="${fieldName}"]`,
        `input[id="${fieldName}"]`,
        `input[placeholder*="${fieldName}"]`,
        `input[aria-label*="${fieldName}"]`,
        `textarea[name="${fieldName}"]`,
        `textarea[id="${fieldName}"]`,
        `select[name="${fieldName}"]`,
        `select[id="${fieldName}"]`,
      ];

      for (let selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element;
      }
      return null;
    }

    // Iterate through mapped data and fill fields
    Object.entries(data).forEach(([key, value]) => {
      const inputElement = findInputElement(key);

      if (inputElement) {
        if (inputElement.tagName.toLowerCase() === 'select') {
          // Handle select elements
          const option = Array.from(inputElement.options).find((opt) =>
            opt.text.toLowerCase().includes(value.toLowerCase())
          );
          if (option) {
            inputElement.value = option.value;
          }
        } else if (inputElement.type === 'file') {
          console.log(`File upload needed for ${key}`);
        } else if (
          inputElement.type === 'checkbox' ||
          inputElement.type === 'radio'
        ) {
          inputElement.checked = !!value;
        } else {
          inputElement.value = value;
        }

        // Trigger input events
        const events = ['input', 'change', 'blur'];
        events.forEach((eventType) => {
          const event = new Event(eventType, { bubbles: true });
          inputElement.dispatchEvent(event);
        });
      }
    });
  }, mappedData);
}

/**
 * Main automation function for job application
 * @param {string} url - Job application URL
 * @param {Object} userData - User data for form filling
 * @returns {Promise<void>}
 */
export async function autoFillJobApplication(url, userData) {
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: ['--start-maximized'],
      timeout: 120000,
    });

    const page = await browser.newPage();

    // Increase default navigation timeout to 2 minutes
    page.setDefaultNavigationTimeout(120000);

    // Navigate to the job application page with increased timeout
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 120000,
    });

    // Wait for the page to be fully loaded
    await page.waitForSelector('input, textarea, select', {
      timeout: 120000,
    });

    // Extract all form fields
    const formFields = await page.evaluate(() => {
      return [...document.querySelectorAll('input, textarea, select')]
        .map((el) => ({
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          type: el.type || '',
          tagName: el.tagName.toLowerCase(),
        }))
        .filter((field) => field.name || field.id || field.placeholder);
    });

    console.log('Detected Form Fields:', formFields);

    // Get intelligent mapping from Ollama
    const mappedData = await intelligentFieldMapping(
      formFields.map((f) => f.name || f.id || f.placeholder),
      userData
    );

    console.log('Mapped Form Data:', mappedData);

    // Fill form fields
    await fillFormFields(page, mappedData);

    // Add a small delay after filling form fields to ensure all changes are processed
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Take a screenshot for verification
    const screenshotPath = `form_filled_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath });

    // Replace waitForTimeout with a Promise-based timeout
    const REVIEW_TIMEOUT = parseInt(process.env.REVIEW_TIMEOUT) || 300000; // 5 minutes default
    await new Promise((resolve) => setTimeout(resolve, REVIEW_TIMEOUT));

    return {
      status: 'success',
      screenshot: screenshotPath,
      message: 'Form filled successfully',
    };
  } catch (error) {
    console.error('Automation Error:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Export helper functions for testing or separate use
export { intelligentFieldMapping, fillFormFields };
