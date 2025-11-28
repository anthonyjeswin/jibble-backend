require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const { nanoid } = require('nanoid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const JIBBLE_API_BASE = 'https://api.jibble.io';
const JIBBLE_API_KEY_ID = process.env.JIBBLE_API_KEY_ID;
const JIBBLE_API_KEY_SECRET = process.env.JIBBLE_API_KEY_SECRET;

if (!JIBBLE_API_KEY_ID || !JIBBLE_API_KEY_SECRET) {
    console.error('ERROR: JIBBLE_API_KEY_ID and JIBBLE_API_KEY_SECRET environment variables are required');
    process.exit(1);
}

// ---------- Database Setup - FIXED ----------
const file = path.join(__dirname, 'db.json');

// Define default data structure
const defaultData = {
    users: [],
    registrations: [],
    logs: [],
    projects: [],
    teams: [],
    auth_tokens: {}
};

const adapter = new JSONFile(file);
const db = new Low(adapter, defaultData);

// Initialize database properly
async function initializeDb() {
    await db.read();
    // Ensure all required fields exist
    db.data = db.data || defaultData;
    db.data.users = db.data.users || [];
    db.data.registrations = db.data.registrations || [];
    db.data.logs = db.data.logs || [];
    db.data.projects = db.data.projects || [];
    db.data.teams = db.data.teams || [];
    db.data.auth_tokens = db.data.auth_tokens || {};
    await db.write();
}

// Initialize on startup
initializeDb().then(() => {
    console.log('✅ Database initialized successfully');
}).catch(error => {
    console.error('❌ Database initialization failed:', error);
});

// ---------- Jibble Authentication Helper Functions ----------
let currentAccessToken = null;
let tokenExpiry = null;

async function getJibbleAccessToken() {
    // Check if we have a valid token
    if (currentAccessToken && tokenExpiry && new Date() < tokenExpiry) {
        return currentAccessToken;
    }

    try {
        console.log('🔐 Getting new Jibble access token...');

        const authResponse = await axios.post(`${JIBBLE_API_BASE}/oauth2/token`,
            `grant_type=client_credentials&client_id=${JIBBLE_API_KEY_ID}&client_secret=${JIBBLE_API_KEY_SECRET}`, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        if (authResponse.data && authResponse.data.access_token) {
            currentAccessToken = authResponse.data.access_token;
            // Set expiry to 50 minutes from now (tokens typically last 1 hour)
            tokenExpiry = new Date(Date.now() + 50 * 60 * 1000);

            // Store token in database for persistence
            await initializeDb();
            db.data.auth_tokens = {
                access_token: currentAccessToken,
                expires_at: tokenExpiry.toISOString(),
                last_updated: new Date().toISOString()
            };
            await db.write();

            console.log('✅ Successfully obtained Jibble access token');
            return currentAccessToken;
        } else {
            throw new Error('No access token in response');
        }
    } catch (error) {
        console.error('❌ Failed to get Jibble access token:', error.response ? error.response.data : error.message);
        throw new Error(`Authentication failed: ${error.response ? error.response.data : error.message}`);
    }
}

function getJibbleHeaders(accessToken) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };
}

async function jibbleApiCall(method, endpoint, data = null) {
    try {
        const accessToken = await getJibbleAccessToken();
        const url = `${JIBBLE_API_BASE}${endpoint}`;
        const config = {
            method: method,
            url: url,
            headers: getJibbleHeaders(accessToken)
        };

        if (data && (method === 'post' || method === 'put' || method === 'patch')) {
            config.data = data;
        }

        const response = await axios(config);
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`Jibble API Error (${method} ${endpoint}):`, error.response ? error.response.data : error.message);

        // If it's an authentication error, clear the token to force refresh
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.log('🔄 Clearing invalid access token...');
            currentAccessToken = null;
            tokenExpiry = null;
        }

        return {
            success: false,
            error: error.response ? error.response.data : error.message,
            status: error.response ? error.response.status : 500
        };
    }
}

// ---------- Initialize Authentication on Startup ----------
async function initializeAuth() {
    try {
        await initializeDb();
        // Check if we have a stored token that's still valid
        if (db.data.auth_tokens && db.data.auth_tokens.access_token) {
            const expiresAt = new Date(db.data.auth_tokens.expires_at);
            if (expiresAt > new Date()) {
                currentAccessToken = db.data.auth_tokens.access_token;
                tokenExpiry = expiresAt;
                console.log('✅ Loaded valid Jibble access token from storage');
                return;
            }
        }
        // Get a new token
        await getJibbleAccessToken();
    } catch (error) {
        console.error('❌ Failed to initialize authentication:', error.message);
    }
}

// ---------- User Registration & Management ----------

// Register Cliq user with Jibble
app.post('/register', async(req, res) => {
    await initializeDb();
    const { cliq_user_id, cliq_user_name, jibble_person_id, jibble_email } = req.body;

    if (!cliq_user_id || (!jibble_person_id && !jibble_email)) {
        return res.status(400).json({
            error: 'cliq_user_id and either jibble_person_id or jibble_email are required'
        });
    }

    const existingRegistration = db.data.registrations.find(r => r.cliq_user_id === cliq_user_id);
    if (existingRegistration) {
        return res.status(400).json({
            error: 'User already registered'
        });
    }

    const registration = {
        id: nanoid(),
        cliq_user_id,
        cliq_user_name: cliq_user_name || 'Unknown',
        jibble_person_id: jibble_person_id || null,
        jibble_email: jibble_email || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    db.data.registrations.push(registration);
    await db.write();

    // Log the action
    db.data.logs.push({
        id: nanoid(),
        type: 'registration',
        cliq_user_id,
        details: `User registered with Jibble`,
        timestamp: new Date().toISOString()
    });
    await db.write();

    res.json({
        success: true,
        message: 'User registered successfully',
        registration
    });
});

// Get all registered users
app.get('/registrations', async(req, res) => {
    await initializeDb();
    res.json({
        success: true,
        registrations: db.data.registrations,
        count: db.data.registrations.length
    });
});

// Get user registration
app.get('/registration/:cliq_user_id', async(req, res) => {
    await initializeDb();
    const { cliq_user_id } = req.params;

    const registration = db.data.registrations.find(r => r.cliq_user_id === cliq_user_id);
    if (!registration) {
        return res.status(404).json({
            error: 'User not registered'
        });
    }

    res.json({
        success: true,
        registration
    });
});

// Delete user registration
app.delete('/registration/:cliq_user_id', async(req, res) => {
    await initializeDb();
    const { cliq_user_id } = req.params;

    const index = db.data.registrations.findIndex(r => r.cliq_user_id === cliq_user_id);
    if (index === -1) {
        return res.status(404).json({
            error: 'User not registered'
        });
    }

    db.data.registrations.splice(index, 1);
    await db.write();

    res.json({
        success: true,
        message: 'User registration deleted successfully'
    });
});

// ---------- Jibble People/Users Management ----------

// Get all people from Jibble (to help with registration)
app.get('/jibble/people', async(req, res) => {
    try {
        const result = await jibbleApiCall('get', '/api/v1/people');

        if (!result.success) {
            throw new Error(result.error.message || 'Failed to fetch people from Jibble');
        }

        res.json({
            success: true,
            people: result.data,
            count: result.data.length
        });

    } catch (error) {
        console.error('Get people error:', error);
        res.status(500).json({
            error: `Failed to fetch people: ${error.message}`
        });
    }
});

// ---------- Core Time Tracking Features ----------

// Clock In
app.post('/clockin', async(req, res) => {
    await initializeDb();
    const { cliq_user_id, project_id, activity_id, note } = req.body;

    try {
        const registration = db.data.registrations.find(r => r.cliq_user_id === cliq_user_id);
        if (!registration) {
            return res.status(400).json({
                error: 'User not registered with Jibble. Please register first using /register'
            });
        }

        const personId = registration.jibble_person_id;
        if (!personId) {
            return res.status(400).json({
                error: 'Jibble person ID not found for this user'
            });
        }

        // Jibble API: Clock in
        const clockInData = {
            person: { id: personId },
            project: project_id ? { id: project_id } : null,
            activity: activity_id ? { id: activity_id } : null,
            note: note || ''
        };

        const result = await jibbleApiCall('post', '/api/v1/clockins', clockInData);

        if (!result.success) {
            throw new Error(result.error.message || 'Failed to clock in');
        }

        // Log successful clock in
        db.data.logs.push({
            id: nanoid(),
            type: 'clockin',
            cliq_user_id,
            details: `Clocked in at ${new Date().toLocaleTimeString()}`,
            timestamp: new Date().toISOString(),
            jibble_response: result.data
        });
        await db.write();

        res.json({
            success: true,
            message: '✅ Clocked in successfully',
            data: result.data,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Clock in error:', error);

        db.data.logs.push({
            id: nanoid(),
            type: 'clockin_error',
            cliq_user_id,
            details: `Clock in failed: ${error.message}`,
            timestamp: new Date().toISOString()
        });
        await db.write();

        res.status(500).json({
            error: `Failed to clock in: ${error.message}`
        });
    }
});

// Clock Out
app.post('/clockout', async(req, res) => {
    await initializeDb();
    const { cliq_user_id, note } = req.body;

    try {
        const registration = db.data.registrations.find(r => r.cliq_user_id === cliq_user_id);
        if (!registration) {
            return res.status(400).json({
                error: 'User not registered with Jibble. Please register first using /register'
            });
        }

        const personId = registration.jibble_person_id;
        if (!personId) {
            return res.status(400).json({
                error: 'Jibble person ID not found for this user'
            });
        }

        // First, get time entries to find active one
        const timeEntriesResult = await jibbleApiCall('get', `/api/v1/people/${personId}/time-entries`);

        if (!timeEntriesResult.success) {
            throw new Error('Failed to fetch time entries');
        }

        // Find active clock-in (entry without end time)
        const activeEntry = timeEntriesResult.data.find(entry =>
            entry.start && !entry.end
        );

        if (!activeEntry) {
            return res.status(400).json({
                error: 'No active clock-in found. You need to clock in first.'
            });
        }

        // Clock out the active entry
        const clockOutData = {
            note: note || ''
        };

        const result = await jibbleApiCall('put', `/api/v1/timeentries/${activeEntry.id}/clockout`, clockOutData);

        if (!result.success) {
            throw new Error(result.error.message || 'Failed to clock out');
        }

        // Log successful clock out
        db.data.logs.push({
            id: nanoid(),
            type: 'clockout',
            cliq_user_id,
            details: `Clocked out at ${new Date().toLocaleTimeString()}`,
            timestamp: new Date().toISOString(),
            jibble_response: result.data
        });
        await db.write();

        // Calculate duration
        const startTime = new Date(activeEntry.start);
        const endTime = new Date();
        const duration = ((endTime - startTime) / (1000 * 60 * 60)).toFixed(2);

        res.json({
            success: true,
            message: `🛑 Clocked out successfully (Duration: ${duration} hours)`,
            data: result.data,
            duration: `${duration} hours`,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Clock out error:', error);

        db.data.logs.push({
            id: nanoid(),
            type: 'clockout_error',
            cliq_user_id,
            details: `Clock out failed: ${error.message}`,
            timestamp: new Date().toISOString()
        });
        await db.write();

        res.status(500).json({
            error: `Failed to clock out: ${error.message}`
        });
    }
});

// Get current clock status
app.get('/clock/status/:cliq_user_id', async(req, res) => {
    await initializeDb();
    const { cliq_user_id } = req.params;

    try {
        const registration = db.data.registrations.find(r => r.cliq_user_id === cliq_user_id);
        if (!registration) {
            return res.status(400).json({
                error: 'User not registered with Jibble'
            });
        }

        const personId = registration.jibble_person_id;
        if (!personId) {
            return res.status(400).json({
                error: 'Jibble person ID not found for this user'
            });
        }

        const timeEntriesResult = await jibbleApiCall('get', `/api/v1/people/${personId}/time-entries`);

        if (!timeEntriesResult.success) {
            throw new Error('Failed to fetch time entries');
        }

        const activeEntry = timeEntriesResult.data.find(entry =>
            entry.start && !entry.end
        );

        if (activeEntry) {
            const startTime = new Date(activeEntry.start);
            const currentDuration = ((new Date() - startTime) / (1000 * 60 * 60)).toFixed(2);

            res.json({
                success: true,
                status: 'clocked_in',
                message: `🟢 Currently clocked in since ${startTime.toLocaleTimeString()} (${currentDuration} hours ago)`,
                start_time: activeEntry.start,
                duration: currentDuration
            });
        } else {
            res.json({
                success: true,
                status: 'clocked_out',
                message: '🔴 Currently clocked out',
                last_activity: timeEntriesResult.data.length > 0 ? timeEntriesResult.data[0].end : null
            });
        }

    } catch (error) {
        console.error('Clock status error:', error);
        res.status(500).json({
            error: `Failed to get clock status: ${error.message}`
        });
    }
});

// ---------- Time Tracking & Reports ----------

// Get today's time entries
app.get('/timesheet/today/:cliq_user_id', async(req, res) => {
    await initializeDb();
    const { cliq_user_id } = req.params;

    try {
        const registration = db.data.registrations.find(r => r.cliq_user_id === cliq_user_id);
        if (!registration) {
            return res.status(400).json({
                error: 'User not registered with Jibble'
            });
        }

        const personId = registration.jibble_person_id;
        if (!personId) {
            return res.status(400).json({
                error: 'Jibble person ID not found for this user'
            });
        }

        const today = new Date().toISOString().split('T')[0];
        const result = await jibbleApiCall('get', `/api/v1/people/${personId}/time-entries?from=${today}&to=${today}`);

        if (!result.success) {
            throw new Error('Failed to fetch time entries');
        }

        const totalHours = result.data.reduce((total, entry) => {
            if (entry.start && entry.end) {
                const start = new Date(entry.start);
                const end = new Date(entry.end);
                return total + (end - start) / (1000 * 60 * 60);
            }
            return total;
        }, 0);

        res.json({
            success: true,
            date: today,
            total_hours: totalHours.toFixed(2),
            entries: result.data,
            entry_count: result.data.length
        });

    } catch (error) {
        console.error('Timesheet error:', error);
        res.status(500).json({
            error: `Failed to fetch timesheet: ${error.message}`
        });
    }
});

// ---------- Project Management ----------

// Get all projects
app.get('/projects', async(req, res) => {
    try {
        const result = await jibbleApiCall('get', '/api/v1/projects');

        if (!result.success) {
            throw new Error('Failed to fetch projects');
        }

        // Cache projects in database
        db.data.projects = result.data;
        await db.write();

        res.json({
            success: true,
            projects: result.data,
            count: result.data.length
        });

    } catch (error) {
        console.error('Projects error:', error);
        res.status(500).json({
            error: `Failed to fetch projects: ${error.message}`
        });
    }
});

// ---------- Team Management ----------

// Get team members
app.get('/team/members', async(req, res) => {
    try {
        const result = await jibbleApiCall('get', '/api/v1/people');

        if (!result.success) {
            throw new Error('Failed to fetch team members');
        }

        // Cache team members
        db.data.teams = result.data;
        await db.write();

        res.json({
            success: true,
            members: result.data,
            count: result.data.length
        });

    } catch (error) {
        console.error('Team members error:', error);
        res.status(500).json({
            error: `Failed to fetch team members: ${error.message}`
        });
    }
});

// ---------- Admin & Monitoring ----------

// Get all logs
app.get('/admin/logs', async(req, res) => {
    await initializeDb();
    const { limit = 100 } = req.query;

    const logs = db.data.logs
        .slice(-limit)
        .reverse();

    res.json({
        success: true,
        logs,
        total: db.data.logs.length
    });
});

// Get statistics
app.get('/admin/stats', async(req, res) => {
    await initializeDb();

    const today = new Date().toISOString().split('T')[0];
    const todayLogs = db.data.logs.filter(log =>
        log.timestamp.startsWith(today)
    );

    const stats = {
        total_registrations: db.data.registrations.length,
        total_logs: db.data.logs.length,
        today_clockins: todayLogs.filter(log => log.type === 'clockin').length,
        today_clockouts: todayLogs.filter(log => log.type === 'clockout').length,
        today_errors: todayLogs.filter(log => log.type.includes('error')).length
    };

    res.json({
        success: true,
        stats
    });
});

// ---------- Utility Endpoints ----------

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Jibble Cliq Bot Server',
        version: '2.0.0'
    });
});

// Jibble API status check
app.get('/status', async(req, res) => {
    try {
        const result = await jibbleApiCall('get', '/api/v1/people?limit=1');

        res.json({
            jibble_api: result.success ? 'connected' : 'disconnected',
            server: 'running',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.json({
            jibble_api: 'disconnected',
            server: 'running',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});

// Get server info
app.get('/info', (req, res) => {
    res.json({
        service: 'Jibble Cliq Bot Server',
        version: '2.0.0',
        endpoints: [
            '/health', '/status', '/info',
            '/register', '/registrations', '/registration/:id',
            '/clockin', '/clockout', '/clock/status/:id',
            '/timesheet/today/:id',
            '/projects', '/team/members',
            '/admin/logs', '/admin/stats'
        ]
    });
});

// ---------- Error Handling ----------

app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        info: 'Visit /info for available endpoints'
    });
});

// ---------- Start Server ----------
initializeAuth().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Jibble Cliq Bot Server running on port ${PORT}`);
        console.log(`🔐 Using Jibble API Key ID: ${JIBBLE_API_KEY_ID.substring(0, 8)}...`);
        console.log(`📊 Health check: http://localhost:${PORT}/health`);
        console.log(`🔗 Jibble status: http://localhost:${PORT}/status`);
        console.log(`📖 API info: http://localhost:${PORT}/info`);
    });
}).catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
});