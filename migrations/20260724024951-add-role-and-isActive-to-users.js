'use strict';

/** @type {import('sequelize-cli').Migration} */
export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'role', {
      type: Sequelize.ENUM('admin', 'user'),
      allowNull: false,
      defaultValue: 'user',
    });

    await queryInterface.addColumn('users', 'isActive', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'isActive');
    await queryInterface.removeColumn('users', 'role');
    // Postgres leaves the enum type behind after removing the column —
    // drop it explicitly so re-running the migration doesn't collide.
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_users_role";');
  },
};