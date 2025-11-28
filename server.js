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
const JIBBLE_API_KEY = process.env.JIBBLE_API_KEY_ID;

if (!JIBBLE_API_KEY) {
    console.error('ERROR: JIBBLE_API_KEY environment variable is required');
    console.error('Get your API key from: Jibble App → Settings → API');
    process.exit(1);
}

// ---------- Database Setup ----------
const file = path.join(__dirname, 'db.json');

// Define default data structure
const defaultData = {
    users: [],
    registrations: [],
    logs: [],
    projects: [],
    teams: []
};

const adapter = new JSONFile(file);
const db = new Low(adapter, defaultData);

// Initialize database properly
async function initializeDb() {
    await db.read();
    db.data = db.data || defaultData;
    db.data.users = db.data.users || [];
    db.data.registrations = db.data.registrations || [];
    db.data.logs = db.data.logs || [];
    db.data.projects = db.data.projects || [];
    db.data.teams = db.data.teams || [];
    await db.write();
}

// Initialize on startup
initializeDb().then(() => {
    console.log('✅ Database initialized successfully');
}).catch(error => {
    console.error('❌ Database initialization failed:', error);
});

// ---------- Jibble API Helper Functions ----------
function getJibbleHeaders() {
    // Jibble typically uses API Key in headers, not OAuth2
    return {
        'Authorization': `Bearer ${JIBBLE_API_KEY}`,
        'Content-Type': 'application/json',
        'X-API-Key': JIBBLE_API_KEY // Some versions use this
    };
}

async function jibbleApiCall(method, endpoint, data = null) {
    try {
        const url = `${JIBBLE_API_BASE}${endpoint}`;
        const config = {
            method: method,
            url: url,
            headers: getJibbleHeaders(),
            timeout: 10000
        };

        if (data && (method === 'post' || method === 'put' || method === 'patch')) {
            config.data = data;
        }

        console.log(`🔗 Making ${method.toUpperCase()} request to: ${endpoint}`);
        const response = await axios(config);

        console.log(`✅ ${method.toUpperCase()} ${endpoint} successful`);
        return { success: true, data: response.data };

    } catch (error) {
        console.error(`❌ Jibble API Error (${method} ${endpoint}):`, error.response ? {
            status: error.response.status,
            data: error.response.data
        } : error.message);

        return {
            success: false,
            error: error.response ? error.response.data : error.message,
            status: error.response ? error.response.status : 500
        };
    }
}

// ---------- API Discovery Endpoint ----------
app.get('/discover', async(req, res) => {
    try {
        console.log('🔍 Discovering Jibble API endpoints...');

        const testEndpoints = [
            '/api/v1/people',
            '/api/v1/projects',
            '/api/v1/me',
            '/people',
            '/projects'
        ];

        const results = [];

        for (const endpoint of testEndpoints) {
            try {
                const result = await jibbleApiCall('get', endpoint);
                results.push({
                    endpoint,
                    status: result.success ? '✅ Working' : '❌ Failed',
                    data: result.success ? 'Has data' : result.error
                });
            } catch (error) {
                results.push({
                    endpoint,
                    status: '❌ Error',
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            base_url: JIBBLE_API_BASE,
            api_key_format: JIBBLE_API_KEY.substring(0, 8) + '...',
            results
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: `Discovery failed: ${error.message}`
        });
    }
});

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

// ---------- Jibble People/Users Management ----------

// Get all people from Jibble (to help with registration)
app.get('/jibble/people', async(req, res) => {
    try {
        console.log('👥 Fetching people from Jibble...');
        const result = await jibbleApiCall('get', '/api/v1/people');

        if (!result.success) {
            // Try alternative endpoint
            const altResult = await jibbleApiCall('get', '/people');
            if (!altResult.success) {
                throw new Error('Failed to fetch people from Jibble. Check API key and endpoints.');
            }
            return res.json({
                success: true,
                people: altResult.data,
                count: altResult.data.length,
                source: 'alternative_endpoint'
            });
        }

        res.json({
            success: true,
            people: result.data,
            count: result.data.length,
            source: 'primary_endpoint'
        });

    } catch (error) {
        console.error('Get people error:', error);
        res.status(500).json({
            error: `Failed to fetch people: ${error.message}`,
            tip: 'Check your Jibble API key and ensure it has proper permissions'
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

        console.log(`🟢 Clocking in user ${cliq_user_id} (Jibble ID: ${personId})`);
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
            timestamp: new Date().toISOString()
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

        console.log(`🔴 Clocking out user ${cliq_user_id} (Jibble ID: ${personId})`);

        // For Jibble, we typically just create a new time entry for clock out
        // or use their specific clock out endpoint if available
        const clockOutData = {
            person: { id: personId },
            note: note || 'Clocked out via Cliq Bot'
        };

        // Try different clock out methods
        let result = await jibbleApiCall('post', '/api/v1/clockouts', clockOutData);

        if (!result.success) {
            // Alternative: Create a time entry with end time
            result = await jibbleApiCall('post', '/api/v1/timeentries', {
                ...clockOutData,
                end: new Date().toISOString()
            });
        }

        if (!result.success) {
            throw new Error(result.error.message || 'Failed to clock out');
        }

        // Log successful clock out
        db.data.logs.push({
            id: nanoid(),
            type: 'clockout',
            cliq_user_id,
            details: `Clocked out at ${new Date().toLocaleTimeString()}`,
            timestamp: new Date().toISOString()
        });
        await db.write();

        res.json({
            success: true,
            message: '🛑 Clocked out successfully',
            data: result.data,
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

        res.json({
            success: true,
            status: 'unknown', // We'll implement proper status checking later
            message: 'Clock status feature - check Jibble app for current status',
            user: registration.cliq_user_name,
            registered: true
        });

    } catch (error) {
        console.error('Clock status error:', error);
        res.status(500).json({
            error: `Failed to get clock status: ${error.message}`
        });
    }
});

// ---------- Time Tracking & Reports ----------

// Get today's time entries (simulated for now)
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

        // For now, return mock data until we figure out the correct Jibble endpoints
        res.json({
            success: true,
            date: new Date().toISOString().split('T')[0],
            total_hours: "0.00",
            entries: [],
            entry_count: 0,
            note: "Time entries will be available once Jibble API is properly connected"
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
            // Try alternative endpoint
            const altResult = await jibbleApiCall('get', '/projects');
            if (!altResult.success) {
                return res.json({
                    success: true,
                    projects: [],
                    count: 0,
                    note: "Projects will be available once Jibble API is properly connected"
                });
            }
            return res.json({
                success: true,
                projects: altResult.data,
                count: altResult.data.length
            });
        }

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
            return res.json({
                success: true,
                members: [],
                count: 0,
                note: "Team members will be available once Jibble API is properly connected"
            });
        }

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
        version: '2.0.0',
        note: 'Server is running. Use /discover to test Jibble API connection.'
    });
});

// Jibble API status check
app.get('/status', async(req, res) => {
    try {
        const result = await jibbleApiCall('get', '/api/v1/people?limit=1');

        res.json({
            jibble_api: result.success ? 'connected' : 'disconnected',
            server: 'running',
            timestamp: new Date().toISOString(),
            note: result.success ?
                'Jibble API is connected successfully!' : 'Jibble API connection failed. Check your API key.'
        });

    } catch (error) {
        res.json({
            jibble_api: 'disconnected',
            server: 'running',
            timestamp: new Date().toISOString(),
            error: 'Jibble API connection failed',
            tip: 'Use /discover endpoint to test API endpoints'
        });
    }
});

// Get server info
app.get('/info', (req, res) => {
    res.json({
        service: 'Jibble Cliq Bot Server',
        version: '2.0.0',
        endpoints: [
            '/health', '/status', '/info', '/discover',
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
app.listen(PORT, () => {
    console.log(`🚀 Jibble Cliq Bot Server running on port ${PORT}`);
    console.log(`🔐 Using Jibble API Key: ${JIBBLE_API_KEY.substring(0, 8)}...`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`🔗 Jibble status: http://localhost:${PORT}/status`);
    console.log(`🔍 API Discovery: http://localhost:${PORT}/discover`);
    console.log(`📖 API info: http://localhost:${PORT}/info`);
});
