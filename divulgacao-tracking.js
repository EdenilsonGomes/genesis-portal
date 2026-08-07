'use strict';
const crypto = require('node:crypto');

function registerDivulgacaoTracking({ app, pool, vacancyUrl, analyticsSecret }) {
  app.get('/r/div/:token', async (req, res) => {
    const token = String(req.params.token || '').trim().slice(0, 100);
    if (!token) return res.redirect(302, '/vagas');
    try {
      const result = await pool.query(`
        SELECT d.id AS destino_id,c.vaga_id,v.id,v.titulo,v.cargo,v.bairro,v.cidade,v.estado
        FROM divulgacao_campanha_destinos d
        JOIN divulgacao_campanhas c ON c.id=d.campanha_id
        JOIN vagas v ON v.id=c.vaga_id
        WHERE d.tracking_token=$1 LIMIT 1
      `, [token]);
      const vacancy = result.rows[0];
      if (!vacancy) return res.redirect(302, '/vagas');
      const ip = String(req.ip || req.headers['x-forwarded-for'] || '');
      const visitor = crypto.createHmac('sha256', String(analyticsSecret || 'genesis-divulgacao')).update(ip).digest('hex');
      await pool.query(`INSERT INTO divulgacao_cliques(destino_id,visitor_hash,referer,user_agent) VALUES($1,$2,$3,$4)`, [vacancy.destino_id, visitor, String(req.get('referer') || '').slice(0, 1000), String(req.get('user-agent') || '').slice(0, 1000)]).catch(() => {});
      return res.redirect(302, vacancyUrl(vacancy));
    } catch (error) {
      if (['42P01','42703'].includes(String(error?.code || ''))) return res.redirect(302, '/vagas');
      console.error('[DIVULGAÇÃO TRACKING]', error.message);
      return res.redirect(302, '/vagas');
    }
  });
}
module.exports = { registerDivulgacaoTracking };
