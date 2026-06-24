export async function up(queryInterface, Sequelize) {
  // Remove the role column from users
  await queryInterface.removeColumn("users", "role");

  // Remove the ENUM type that Postgres creates for ENUM columns
  await queryInterface.sequelize.query(
    'DROP TYPE IF EXISTS "enum_users_role";'
  );
}

export async function down(queryInterface, Sequelize) {
  // Restore role column if you ever rollback
  await queryInterface.addColumn("users", "role", {
    type: Sequelize.ENUM("admin", "user"),
    allowNull: false,
    defaultValue: "user",
  });
}