require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ---------- Supabase Admin Client ----------
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Auth Middleware ----------
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.user = data.user;
  next();
}

// ==============================================
//  POSTS
// ==============================================

// GET /api/posts — list all posts (newest first)
app.get('/api/posts', async (req, res) => {
  try {
    // Optional: pass ?user_id= to get the liked status
    const currentUserId = req.query.user_id || null;

    const { data: posts, error } = await supabaseAdmin
      .from('posts')
      .select(`
        id,
        content,
        image_url,
        created_at,
        user_id,
        profiles!posts_user_id_fkey ( username, avatar_url )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // For each post, get like count and whether current user liked it
    const enriched = await Promise.all(
      posts.map(async (post) => {
        const { count: likeCount } = await supabaseAdmin
          .from('likes')
          .select('*', { count: 'exact', head: true })
          .eq('post_id', post.id);

        const { count: commentCount } = await supabaseAdmin
          .from('comments')
          .select('*', { count: 'exact', head: true })
          .eq('post_id', post.id);

        let likedByMe = false;
        if (currentUserId) {
          const { data: myLike } = await supabaseAdmin
            .from('likes')
            .select('id')
            .eq('post_id', post.id)
            .eq('user_id', currentUserId)
            .maybeSingle();
          likedByMe = !!myLike;
        }

        return {
          ...post,
          author: post.profiles?.username || 'Unknown',
          avatar_url: post.profiles?.avatar_url || null,
          like_count: likeCount || 0,
          comment_count: commentCount || 0,
          liked_by_me: likedByMe,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// POST /api/posts — create text post
app.post('/api/posts', authenticate, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    const { data, error } = await supabaseAdmin
      .from('posts')
      .insert({ user_id: req.user.id, content: content.trim() })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// POST /api/posts/upload — create post with image
app.post('/api/posts/upload', authenticate, upload.single('image'), async (req, res) => {
  try {
    const content = req.body.content || '';
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    // Upload to Supabase storage
    const fileName = `${req.user.id}/${Date.now()}_${file.originalname}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from('post-images')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from('post-images')
      .getPublicUrl(fileName);

    const image_url = urlData.publicUrl;

    const { data, error } = await supabaseAdmin
      .from('posts')
      .insert({ user_id: req.user.id, content: content.trim(), image_url })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post with image' });
  }
});

// DELETE /api/posts/:id — delete own post
app.delete('/api/posts/:id', authenticate, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('posts')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// PUT /api/posts/:id — update own post
app.put('/api/posts/:id', authenticate, async (req, res) => {
  try {
    const { content, remove_image } = req.body;

    // 1. Verify ownership first
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('posts')
      .select('id, image_url')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Post not found or unauthorized' });
    }

    const updates = {};
    if (content !== undefined) updates.content = content.trim();
    if (remove_image) {
      updates.image_url = null;
      // Optional: Delete from storage bucket here if desired
      // await supabaseAdmin.storage.from('post-images').remove([existing.image_url]);
    }

    const { data, error } = await supabaseAdmin
      .from('posts')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// ==============================================
//  LIKES
// ==============================================

// POST /api/posts/:id/like — toggle like
app.post('/api/posts/:id/like', authenticate, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    // Check if already liked
    const { data: existing } = await supabaseAdmin
      .from('likes')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      // Unlike
      await supabaseAdmin.from('likes').delete().eq('id', existing.id);
      return res.json({ liked: false });
    } else {
      // Like
      await supabaseAdmin.from('likes').insert({ user_id: userId, post_id: postId });
      return res.json({ liked: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

// ==============================================
//  COMMENTS
// ==============================================

// GET /api/posts/:id/comments
app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('comments')
      .select(`
        id,
        content,
        created_at,
        user_id,
        profiles!comments_user_id_fkey ( username, avatar_url )
      `)
      .eq('post_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    const comments = data.map((c) => ({
      ...c,
      author: c.profiles?.username || 'Unknown',
      avatar_url: c.profiles?.avatar_url || null,
    }));

    res.json(comments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// POST /api/posts/:id/comments
app.post('/api/posts/:id/comments', authenticate, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('comments')
      .insert({
        user_id: req.user.id,
        post_id: req.params.id,
        content: content.trim(),
      })
      .select(`
        id,
        content,
        created_at,
        user_id,
        profiles!comments_user_id_fkey ( username, avatar_url )
      `)
      .single();

    if (error) throw error;

    res.status(201).json({
      ...data,
      author: data.profiles?.username || 'Unknown',
      avatar_url: data.profiles?.avatar_url || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// ==============================================
//  PROFILE
// ==============================================

// GET /api/profile — get current user's profile
app.get('/api/profile', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ==============================================
//  Health check
// ==============================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------- Start (local dev only, Vercel handles this in production) ----------
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
}

module.exports = app;
